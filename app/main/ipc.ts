import type { IpcMain, IpcRenderer } from 'electron';
import type { ChatTurn, Project } from '../../shared/api-contract.js';

export interface ChatStreamEvent {
  turnId: string;
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'permission_request'
    | 'turn_done'
    | 'error';
  payload: unknown;
}

export interface OnboardingStatus {
  /** True once the user has chosen sign-in or guest AND picked a projects folder. */
  setupComplete: boolean;
  /** True if the user is using the app as a guest (no cloud features). */
  guest: boolean;
  /** True if a real Auth0 session exists. */
  signedIn: boolean;
  /** Where new projects will be created on disk. */
  projectsRoot: string;
  /** Suggested default path the user can accept on the picker. */
  defaultProjectsRoot: string;
}

export interface ApiSurface {
  /** Onboarding: returns everything the wizard needs to decide its stage. */
  'onboarding:status': () => Promise<OnboardingStatus>;
  /** Persist the projects-folder choice and mark setup complete. */
  'onboarding:setProjectsRoot': (input: { projectsRoot: string }) => Promise<OnboardingStatus>;
  /** Mark "use as guest" (also flips setupComplete via the next setProjectsRoot). */
  'onboarding:setGuest': (input: { guest: boolean }) => Promise<OnboardingStatus>;
  /** Show a native folder picker. Returns the chosen path or undefined if cancelled. */
  'onboarding:pickFolder': (input: { defaultPath?: string }) => Promise<string | undefined>;

  'auth:login': () => Promise<{ sub: string; email?: string }>;
  'auth:logout': () => Promise<void>;
  'auth:status': () => Promise<{ signedIn: boolean; sub?: string; email?: string }>;

  'projects:list': () => Promise<Project[]>;
  'projects:create': (input: { name: string; slug: string; harnessId?: string }) => Promise<Project>;
  'projects:open': (projectId: string) => Promise<{ project: Project; previewUrl?: string }>;
  'projects:close': (projectId: string) => Promise<void>;
  /** Permanently delete a project from local disk (worktree + state). */
  'projects:delete': (input: { projectId: string }) => Promise<void>;
  /** True if the project's worktree has user content (any non-git file).
   *  Used to decide whether to show the "fresh-start" hero + sample prompts. */
  'projects:hasContent': (input: { projectId: string }) => Promise<boolean>;
  /** Returns the most-recently-opened project, or undefined if the user has none. */
  'projects:current': () => Promise<Project | undefined>;
  /** Switch the harness adapter for a project and reset any active session. */
  'projects:setHarness': (input: { projectId: string; harnessId: string }) => Promise<Project>;
  /** Which harness id will be used by default given the current credentials. */
  'harness:info': () => Promise<{ defaultAdapterId: string; available: string[] }>;
  /** List starter skills (e.g. "new-app") for the new-project picker. */
  'plugins:starters': () => Promise<Array<{ id: string; name: string; description: string; pluginName: string }>>;

  'chat:send': (input: {
    projectId: string;
    message: string;
  }) => Promise<{ streamChannel: string }>;
  'chat:history': (input: {
    projectId: string;
    cursor?: string;
  }) => Promise<{ turns: ChatTurn[]; nextCursor?: string }>;
  'chat:approvePermission': (input: {
    requestId: string;
    decision: 'allow' | 'allow_once' | 'deny';
  }) => Promise<void>;
  'chat:interrupt': (input: { projectId: string }) => Promise<void>;

  /** Publish the current source to the cloud. Listens on
   *  `publish:progress:<projectId>` for per-phase updates. Resolves with the URL. */
  'projects:publish': (input: { projectId: string }) => Promise<{ version: number; publishedUrl: string }>;
  /** Mint a share code for the project. */
  'projects:share': (input: { projectId: string; grants?: 'view' | 'edit'; expiresAt?: string }) => Promise<{ code: string }>;
  /** Open an existing project via a share code. Clones source to a new local project. */
  'projects:joinByCode': (input: { code: string }) => Promise<Project>;
}

export type ApiChannel = keyof ApiSurface;

export type ApiInvoke = <K extends ApiChannel>(
  channel: K,
  ...args: Parameters<ApiSurface[K]>
) => ReturnType<ApiSurface[K]>;

export type PublishProgressEvent =
  | { phase: 'building' }
  | { phase: 'packaging' }
  | { phase: 'uploading'; bytes: number }
  | { phase: 'activating' }
  | { phase: 'live'; url: string }
  | { phase: 'failed'; error: string };

export interface RendererBridge {
  invoke: ApiInvoke;
  onChatStream: (
    channel: string,
    handler: (event: ChatStreamEvent) => void,
  ) => () => void;
  onPreviewUrl: (handler: (url: string) => void) => () => void;
  /** Listen for publish progress on a specific job channel. */
  onPublishProgress: (jobId: string, handler: (event: PublishProgressEvent) => void) => () => void;
}

/** Register all IPC handlers in the main process. */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  impl: { [K in ApiChannel]: ApiSurface[K] },
): void {
  for (const key of Object.keys(impl) as ApiChannel[]) {
    ipcMain.handle(key, (_evt, ...args) =>
      (impl[key] as (...args: unknown[]) => unknown)(...args),
    );
  }
}

/** Build the renderer-side bridge that the preload script exposes. */
export function buildRendererBridge(ipcRenderer: IpcRenderer): RendererBridge {
  return {
    invoke: ((channel: ApiChannel, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args)) as ApiInvoke,

    onChatStream(channel, handler) {
      const listener = (_e: unknown, event: ChatStreamEvent) => handler(event);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },

    onPreviewUrl(handler) {
      const listener = (_e: unknown, url: string) => handler(url);
      ipcRenderer.on('preview:url', listener);
      return () => ipcRenderer.removeListener('preview:url', listener);
    },

    onPublishProgress(jobId, handler) {
      const channel = `publish:progress:${jobId}`;
      const listener = (_e: unknown, event: PublishProgressEvent) => handler(event);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  };
}
