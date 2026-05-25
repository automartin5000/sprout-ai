import { app, dialog, ipcMain } from 'electron';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Project } from '../../shared/api-contract.js';
import { Auth0Native, type UserProfile } from './auth/auth0-native.js';
import { ApiClient, buildTokenProvider } from './cloud/api-client.js';
import { HarnessRegistry } from './harness/registry.js';
import type { HarnessSession, PermissionRequest } from './harness/types.js';
import { OnboardingStateStore } from './onboarding/state.js';
import { discoverPlugins } from './plugins/loader.js';
import type { LoadedPlugin } from './plugins/types.js';
import { ProjectManager } from './projects/manager.js';
import { PublishClient } from './publish/client.js';
import type { ApiSurface, OnboardingStatus, PublishProgressEvent } from './ipc.js';

/**
 * System prompt prepended to every Sprout chat session. The contract here is
 * "Sprout decides, the user describes". Pairs with `disallowedTools:
 * ['AskUserQuestion']` in claude-adapter.ts — if the model tries to ask, the
 * SDK blocks the tool call entirely, but the prompt makes it explicit so the
 * model doesn't even attempt it.
 */
const SPROUT_SYSTEM_PROMPT = `You are Sprout's coding agent, helping a non-technical user build a web app.

Hard rules:
- NEVER ask the user technical questions. Pick reasonable defaults and proceed.
- Specifically: do not call AskUserQuestion or any "ask the user a question" tool — it is disabled. If you find yourself wanting to ask, instead pick the most reasonable option and tell the user what you chose in plain English.
- The user is NOT a developer. They will not know what a framework, route, schema, IAM role, or "shell" is. Translate any technical idea into plain English ("the page that shows…", "the part that saves data…", "the place where people sign in…").
- The user has NO AWS account, NO CLI, NO build environment of their own. Sprout hosts everything on shared infrastructure — do not ask them to install anything, configure credentials, or run any cloud-setup workflow. Do not invoke vibe-aws:onboard or any AWS-account-onboarding flow.
- Apps run on Sprout's shared runtime Lambda. Server code reads three env vars at runtime: SPROUT_PROJECT_ID, SPROUT_DATA_TABLE, SPROUT_ASSETS_BUCKET. Every DynamoDB key MUST be prefixed with \`PROJECT#\${SPROUT_PROJECT_ID}#\` — tenancy depends on it.
- Use \`npm\` for installs and scripts. Do NOT use bun, pnpm, yarn, or bunx — only \`npm install\` and \`npm run <script>\` (or \`npx <tool>\`). The user may not have anything except node + npm.
- When a turn is done, leave the workspace in a buildable state. Run \`npm run build\` to confirm before declaring done.

Tool-call hygiene — the user SEES every tool call you make in a timeline. Every \`description\` field must read like a plain-English status line, not a developer log:
- ❌ "Check git history details"  ✅ "Look at recent save points"
- ❌ "Scaffold Vite React TS template"  ✅ "Set up the starter files"
- ❌ "Check sprout scaffolds and pj tool"  ✅ "Take stock of what's installed"
- ❌ "Test simple bash"  ✅ "Make sure things work"
- ❌ "Check bun availability"  (don't even check — just use npm)  ✅ omit
- ❌ "Look for templates"  ✅ "Find the starter to copy"
- The 'description' on a Bash tool is what the user reads. Avoid: "git", "shell", "bash", "scaffold", "template", "CLI", "binary", "compile", "transpile", "tsx", "vite", "pnpm", "bun", "PATH", framework/tool names.
- Refer to the git-based checkpoint mechanic as "save points", never "git history" or "commits".

Filesystem rules:
- All work happens inside the user's project directory (the cwd). Do NOT \`ls\` / \`find\` / \`grep\` outside the project — not /, not /tmp, not /usr, not the user's home directory. If you need to know if a tool exists, just try to use it and handle failure.
- If you do need to search, pass narrow paths and add \`-maxdepth\` limits. A search that takes more than ~10 seconds is almost always wrong.

Plugin assets:
- Sprout's bundled starter files live under \`\${CLAUDE_PLUGIN_ROOT}\` — that env var is ALREADY set in your environment when this turn started. Use it as-is. Do NOT search the filesystem for it. The starter template is at \`\${CLAUDE_PLUGIN_ROOT}/templates/hono-react\`, the bootstrap script at \`\${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-app.sh\`.
- If \`echo "$CLAUDE_PLUGIN_ROOT"\` returns empty, the bundle is broken — surface it to the user rather than wandering.

How to talk to the user:
- Be brief. Three lines max unless they ask for detail.
- When you make a choice, name it ("I'll use a simple JSON file for now"), don't justify it.
- When you finish a step, say what changed and what they can do next ("Added a sign-in screen — try clicking 'Sign in'").

What the Sprout UI actually offers — only reference these:
- A **chat box** (where the user is talking to you now)
- A **preview pane** that appears alongside the chat once you've scaffolded a project — it shows the running app live. The preview attaches automatically when the dev server starts; the user doesn't have to click anything to refresh.
- A **Publish to cloud** button in the top bar — for putting the app on the public internet
- A **Share** button in the top bar — for inviting collaborators via a project code
- Do NOT reference: "Refresh preview", "Run", "Reload", "Build", "Deploy", "Restart" buttons, or anything in a sidebar/menu. None of those exist.
- If the user needs to see a change, say "It's live in the preview" — never "click Refresh".
`;

export interface ServicesOpts {
  mainWindow: () => BrowserWindow | null;
  attachPreview: (url: string) => void;
  /** Tear down the native preview view. Called when the user navigates away
   *  from a project, so the WebContentsView doesn't keep painting over the
   *  empty right pane after the React shell has swapped to onboarding. */
  detachPreview: () => void;
}

/**
 * Wires the renderer-facing IPC surface to real implementations of:
 *   - Auth0 native PKCE (or mock when MOCK_AUTH=1)
 *   - ProjectManager (worktrees + dev-server)
 *   - HarnessRegistry (Copilot, Claude, mock)
 *   - PluginLoader (bundled + user + project plugins)
 *
 * One method per IPC channel, returning the same shape declared in
 * app/main/ipc.ts so the TypeScript bridge stays sound.
 */
export class Services {
  private readonly projects: ProjectManager;
  private readonly registry: HarnessRegistry;
  private readonly auth0?: Auth0Native;
  private readonly mockAuth: boolean;
  private readonly onboarding = new OnboardingStateStore();
  private readonly apiClient: ApiClient;
  private readonly publishClient: PublishClient;

  private profile?: UserProfile;
  private plugins: LoadedPlugin[] = [];
  private currentSession?: HarnessSession;
  private currentSessionProject?: string;
  private currentSessionHarnessId?: string;

  constructor(private readonly deps: ServicesOpts) {
    this.mockAuth = process.env.MOCK_AUTH === '1';
    this.projects = new ProjectManager();
    this.registry = new HarnessRegistry({
      copilotTokenProvider: async () => process.env.COPILOT_GITHUB_TOKEN ?? '',
    });

    if (!this.mockAuth) {
      const domain = process.env.AUTH0_DOMAIN;
      const clientId = process.env.AUTH0_NATIVE_CLIENT_ID;
      const audience = process.env.AUTH0_AUDIENCE;
      if (domain && clientId && audience) {
        this.auth0 = new Auth0Native({ domain, clientId, audience });
      }
    }

    // Cloud API client. baseUrl comes from CLOUD_API_URL (set in .env / build).
    // If unset, cloud features will fail gracefully when invoked.
    const cloudBaseUrl = process.env.CLOUD_API_URL ?? process.env.LOCAL_API_URL ?? 'http://localhost:3001';
    this.apiClient = new ApiClient({
      baseUrl: cloudBaseUrl,
      tokenProvider: buildTokenProvider(this.auth0, this.mockAuth),
    });
    this.publishClient = new PublishClient(this.apiClient);
  }

  async init(): Promise<void> {
    // `process.resourcesPath` is undefined outside the Electron runtime
    // (e.g. the bundle-smoke test). Fall back to an obviously-absent dir
    // so the plugin loader's stat will just produce zero plugins instead
    // of throwing.
    const resources = process.resourcesPath || path.join(app.getPath('userData'), '_no_bundled_resources');
    const bundledPluginsDir = path.join(resources, 'plugins');
    const userPluginsDir = path.join(app.getPath('userData'), 'plugins');
    this.plugins = await discoverPlugins({
      bundledDir: bundledPluginsDir,
      userDir: userPluginsDir,
    });

    // Apply persisted projects-root choice (if any) so ProjectManager creates
    // new projects in the user's chosen folder rather than userData/projects.
    const state = await this.onboarding.load();
    if (state.projectsRoot) {
      this.projects.setRootDir(state.projectsRoot);
    }

    if (!this.mockAuth && this.auth0) {
      this.profile = await this.auth0.restore().catch(() => undefined);
    } else if (this.mockAuth) {
      this.profile = { sub: 'local|dev-user', email: 'dev@sprout.local' };
    }
  }

  private async buildOnboardingStatus(): Promise<OnboardingStatus> {
    const s = await this.onboarding.load();
    const projectsRoot = await this.onboarding.effectiveProjectsRoot();
    return {
      setupComplete: s.setupComplete,
      guest: s.guest,
      signedIn: !!this.profile,
      projectsRoot,
      defaultProjectsRoot: OnboardingStateStore.defaultProjectsRoot(),
    };
  }

  /**
   * Pick the most-recently-opened project, or undefined if the user has none.
   * The renderer routes to the onboarding wizard when this returns undefined.
   */
  private async resolveCurrentProject(): Promise<Project | undefined> {
    const existing = await this.projects.list();
    if (existing.length === 0) return undefined;
    return [...existing].sort((a, b) =>
      (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
    )[0];
  }

  /** The object plugged into registerIpcHandlers — one entry per ApiChannel. */
  api(): { [K in keyof ApiSurface]: ApiSurface[K] } {
    return {
      'onboarding:status': async () => this.buildOnboardingStatus(),

      'onboarding:setProjectsRoot': async ({ projectsRoot }) => {
        await this.onboarding.save({ projectsRoot, setupComplete: true });
        this.projects.setRootDir(projectsRoot);
        return this.buildOnboardingStatus();
      },

      'onboarding:setGuest': async ({ guest }) => {
        await this.onboarding.save({ guest });
        return this.buildOnboardingStatus();
      },

      'onboarding:pickFolder': async ({ defaultPath }) => {
        const window = this.deps.mainWindow();
        const result = await dialog.showOpenDialog(window ?? undefined as never, {
          title: 'Choose a folder for your projects',
          defaultPath: defaultPath ?? OnboardingStateStore.defaultProjectsRoot(),
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Use this folder',
        });
        if (result.canceled || result.filePaths.length === 0) return undefined;
        return result.filePaths[0];
      },

      'auth:login': async () => {
        if (this.mockAuth) {
          this.profile = { sub: 'local|dev-user', email: 'dev@sprout.local' };
          return this.profile;
        }
        if (!this.auth0) throw new Error('auth0 not configured');
        this.profile = await this.auth0.login();
        return this.profile;
      },

      'auth:logout': async () => {
        await this.auth0?.logout();
        this.profile = undefined;
      },

      'auth:status': async () => {
        if (!this.profile) return { signedIn: false };
        return { signedIn: true, sub: this.profile.sub, email: this.profile.email };
      },

      'projects:list': async () => this.projects.list(),

      'projects:create': async ({ name, slug, harnessId }) => {
        const rec = await this.projects.create({
          name,
          slug,
          harnessId: harnessId as Project['harnessId'] | undefined,
        });
        return rec.project;
      },

      'projects:open': async (projectId: string) => {
        const rec = await this.projects.open(projectId);
        let previewUrl: string | undefined;
        try {
          previewUrl = await this.projects.startDevServer(projectId);
          this.deps.attachPreview(previewUrl);
        } catch (err) {
          // NoDevServerError is the normal case for a freshly-created project
          // that hasn't been scaffolded yet — don't spam the console for it.
          const isNoDevServer =
            err instanceof Error && 'code' in err && (err as { code?: string }).code === 'NO_DEV_SERVER';
          if (!isNoDevServer) {
            console.warn('dev server failed to start; project opened without preview:', err);
          }
        }
        return { project: rec.project, previewUrl };
      },

      'projects:close': async (projectId: string) => {
        // Tear down the native preview view BEFORE stopping the dev server,
        // so the user sees the preview disappear immediately rather than
        // waiting for SIGTERM to land.
        this.deps.detachPreview();
        await this.projects.close(projectId);
      },

      'projects:hasContent': async ({ projectId }) => this.projects.hasContent(projectId),

      'projects:delete': async ({ projectId }) => {
        // If the project we're deleting is the active harness session's
        // project, tear that session down too. Otherwise the next chat
        // message would talk to a non-existent worktree.
        if (this.currentSessionProject === projectId) {
          this.currentSession?.interrupt();
          this.currentSession = undefined;
          this.currentSessionProject = undefined;
          this.currentSessionHarnessId = undefined;
        }
        await this.projects.delete(projectId);
      },

      'projects:current': async () => this.resolveCurrentProject(),

      'projects:setHarness': async ({ projectId, harnessId }) => {
        if (this.currentSessionProject === projectId) {
          this.currentSession?.interrupt();
          await this.currentSession?.dispose().catch(() => undefined);
          this.currentSession = undefined;
          this.currentSessionProject = undefined;
        }
        return this.projects.updateHarness(projectId, harnessId as Project['harnessId']);
      },

      'harness:info': async () => ({
        defaultAdapterId: this.registry.defaultAdapterId(),
        available: this.registry.list(),
      }),

      'plugins:starters': async () => {
        // A "starter" is any skill whose name hints at scaffolding a new project.
        // We surface these in the new-project picker so non-technical users
        // can pick a template without browsing the full plugin tree.
        const matchers = [/^new-app$/i, /^create-app$/i, /scaffold/i, /^starter/i, /^template/i];
        const starters = this.plugins.flatMap((p) =>
          p.skills
            .filter((s) => matchers.some((rx) => rx.test(s.name)))
            .map((s) => ({
              id: `${p.manifest.name}:${s.name}`,
              name: s.name,
              description: s.description,
              pluginName: p.manifest.name,
            })),
        );
        return starters;
      },

      'chat:send': async ({ projectId, message }) => {
        let rec = await this.projects.open(projectId);

        // Auto-migrate projects whose persisted harnessId isn't loadable on
        // this machine. The geoguesser-style case: a project was created
        // back when Copilot was hardcoded as the default, but the user
        // doesn't have `@github/copilot-sdk` installed. Without this
        // fallback every chat send would throw "copilot SDK not available"
        // and there's no UI path to recover. We rewrite the project's
        // harnessId to the registry's default and continue — the user sees
        // the AI dropdown flip to Claude.
        if (!this.registry.isAvailable(rec.project.harnessId)) {
          const fallback = this.registry.defaultAdapterId() as Project['harnessId'];
          const updated = await this.projects.updateHarness(projectId, fallback);
          rec = { ...rec, project: updated };
        }

        const adapter = this.registry.get(rec.project.harnessId);
        const window = this.deps.mainWindow();

        if (!this.currentSession ||
            this.currentSessionProject !== projectId ||
            this.currentSessionHarnessId !== rec.project.harnessId) {
          // Expose plugin roots to the AI's Bash tool. Skill files reference
          // bundled assets via `${CLAUDE_PLUGIN_ROOT}/templates/...` and
          // `${CLAUDE_PLUGIN_ROOT}/scripts/...`. Without these env vars,
          // shell expansion yields the empty string and the AI thrashes
          // looking for the bootstrap script. Set the variable on the Node
          // process env so child shells inherit it.
          const sproutPlugin = this.plugins.find((p) => p.manifest.name === 'sprout');
          if (sproutPlugin) {
            process.env.CLAUDE_PLUGIN_ROOT = sproutPlugin.root;
            process.env.SPROUT_PLUGIN_ROOT = sproutPlugin.root;
          }

          this.currentSession = await adapter.startSession({
            projectRoot: rec.worktree.root,
            tools: [],
            skills: this.plugins.flatMap((p) => p.skills),
            agents: this.plugins.flatMap((p) => p.agents),
            permissionCallback: (req: PermissionRequest) =>
              this.proxyPermissionToRenderer(req, projectId),
            model: rec.project.modelId,
            systemPrompt: SPROUT_SYSTEM_PROMPT,
          });
          this.currentSessionProject = projectId;
          this.currentSessionHarnessId = rec.project.harnessId;
        }

        const streamChannel = `chat:stream:${projectId}`;
        // Pump events to the renderer without awaiting completion.
        void (async () => {
          let sawTurnDone = false;
          const send = (type: string, payload: unknown): void => {
            window?.webContents.send(streamChannel, { turnId: 'pending', type, payload });
          };
          try {
            for await (const event of this.currentSession!.send(message)) {
              if (event.type === 'turn_done') sawTurnDone = true;
              send(event.type, event);
            }
          } catch (err) {
            send('error', { error: String(err) });
          } finally {
            // Always guarantee turn_done so the renderer doesn't hang.
            if (!sawTurnDone) send('turn_done', {});
          }
          // Checkpoint the worktree after each turn.
          await rec.worktree.checkpoint(message).catch(() => undefined);

          // Try to (re)start the dev server now that the AI may have written
          // files. The initial projects:open call ran before any scaffold,
          // so it threw NoDevServerError on the empty worktree. Now that
          // package.json / index.html likely exist, give it another go.
          // startDevServer dedupes if one is already running.
          try {
            const previewUrl = await this.projects.startDevServer(projectId);
            this.deps.attachPreview(previewUrl);
          } catch {
            // NoDevServerError (still nothing scaffolded) or other failure
            // — silently leave the chat-only layout in place. The next turn
            // will retry.
          }
        })();

        return { streamChannel };
      },

      'chat:history': async () => ({ turns: [] }),

      'chat:approvePermission': async ({ requestId, decision }) => {
        this.currentSession?.approvePermission(requestId, decision);
      },

      'chat:interrupt': async () => {
        this.currentSession?.interrupt();
      },

      'projects:publish': async ({ projectId }) => {
        const rec = await this.projects.open(projectId);
        const window = this.deps.mainWindow();
        // Phase 3 publish doesn't allocate a jobId — the renderer listens on
        // `publish:progress:<projectId>` directly and the desktop streams
        // phase events as it walks build → package → upload → activate → live.
        const send = (event: PublishProgressEvent): void => {
          window?.webContents.send(`publish:progress:${projectId}`, event);
        };
        return this.publishClient.publish({
          projectRoot: rec.worktree.root,
          projectId,
          onProgress: (event) => send(event),
        });
      },

      'projects:share': async ({ projectId, grants, expiresAt }) => {
        return this.apiClient.post<{ code: string }>(
          `/projects/${projectId}/share`,
          { grants, expiresAt },
        );
      },

      'projects:joinByCode': async ({ code }) => {
        // 1. Fetch share metadata + presigned source URL from API (unauthed)
        type OpenResp = {
          projectId: string;
          projectName: string;
          ownerSub: string;
          grants: 'view' | 'edit';
          publishedUrl?: string;
          sourceUrl?: string;
        };
        const meta = await this.apiClient.get<OpenResp>(`/share/${code}/open`, { anonymous: true });

        // 2. Create a local project record under the configured projectsRoot
        const harnessId = this.registry.defaultAdapterId() as Project['harnessId'];
        const rec = await this.projects.create({
          name: meta.projectName,
          slug: meta.projectName,
          harnessId,
        });

        // 3. (Optional v1) Download + extract the source tarball if available.
        //    Skipped for the initial cut — the project lands as an empty worktree
        //    and the user can re-pull via "Sync" later. Tracked as a follow-up.
        return rec.project;
      },
    };
  }

  /**
   * Permission-callback for harness tools.
   *
   * Sprout has no permission UI today — we just trust the AI. Sending a
   * `permission_request` event to the renderer is kept for future audit/UI
   * work, but the decision is returned IMMEDIATELY as `allow`. Previously
   * this method waited up to 5 minutes for a renderer response that
   * couldn't arrive, then defaulted to `deny`, which made every Bash/Read/
   * Write call appear to hang for 5 minutes before being silently refused.
   */
  private async proxyPermissionToRenderer(
    req: PermissionRequest,
    projectId: string,
  ): Promise<'allow' | 'allow_once' | 'deny'> {
    const window = this.deps.mainWindow();
    window?.webContents.send(`chat:stream:${projectId}`, {
      turnId: 'pending',
      type: 'permission_request',
      payload: req,
    });
    return 'allow';
  }
}
