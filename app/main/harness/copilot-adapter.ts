import type {
  Attachment,
  HarnessAdapter,
  HarnessEvent,
  HarnessSession,
  PermissionDecision,
  StartSessionOpts,
  ToolDef,
  Turn,
} from './types.js';

/**
 * Token provider — supplied by the auth layer. The adapter never reaches into
 * the auth module directly; this keeps the SDK isolated behind one boundary.
 */
export type CopilotTokenProvider = () => Promise<string>;

/**
 * The Copilot SDK is loaded dynamically so the rest of the main process can
 * import this file without forcing the (heavy, native-binary-bundling) SDK
 * into the bundle when running tests or the mock adapter.
 *
 * Public preview surface (Apr 2026) we rely on:
 *   - `new CopilotClient({ auth, workspaceRoot, model? })`
 *   - `client.createSession({ tools, skills, agents, onPermission })`
 *   - `session.send(message, { attachments? })` -> AsyncIterable<SdkEvent>
 *   - `session.approvePermission(id, decision)`
 *   - `session.interrupt()` / `session.dispose()`
 *
 * If the SDK churns again we change this file only — the HarnessAdapter
 * contract above does not move.
 */
// The SDK is pinned but installed lazily via electron-builder's extraResources
// or a separately-vendored copy. We deliberately do not import it for types so
// the rest of the build doesn't require the package to be present at compile
// time. The adapter is the only place that talks to the SDK.
type CopilotSdkModule = {
  CopilotClient: new (...args: unknown[]) => unknown;
};

let cachedSdkModule: CopilotSdkModule | undefined;
async function loadSdk(): Promise<CopilotSdkModule> {
  if (cachedSdkModule) return cachedSdkModule;
  const mod = await import(/* @vite-ignore */ '@github/copilot-sdk' as string).catch(() => {
    throw new Error(
      'copilot SDK not available — bundle @github/copilot-sdk into app/resources or install it as a dependency before using the copilot harness',
    );
  });
  cachedSdkModule = mod as CopilotSdkModule;
  return cachedSdkModule;
}

export class CopilotAdapter implements HarnessAdapter {
  readonly id = 'copilot';

  constructor(
    private readonly opts: {
      tokenProvider: CopilotTokenProvider;
      defaultModel?: string;
    },
  ) {}

  async startSession(opts: StartSessionOpts): Promise<HarnessSession> {
    const sdk = await loadSdk();
    const token = await this.opts.tokenProvider();

    const sdkClient = new sdk.CopilotClient({
      auth: { token },
      workspaceRoot: opts.projectRoot,
      model: opts.model ?? this.opts.defaultModel,
    }) as {
      createSession(args: unknown): Promise<unknown>;
      dispose?(): Promise<void>;
    };

    const sdkSession = await sdkClient.createSession({
      tools: opts.tools.map(toSdkTool),
      skills: opts.skills.map((s) => ({ path: s.dir })),
      agents: opts.agents.map((a) => ({ path: a.path })),
      systemPrompt: opts.systemPrompt,
      onPermission: opts.permissionCallback,
    });

    return new CopilotHarnessSession(sdkSession as SdkSession);
  }

  async dispose(): Promise<void> {
    /* CopilotClient instances are owned by sessions; nothing to clean here. */
  }
}

interface SdkEvent {
  type: string;
  [key: string]: unknown;
}

interface SdkSession {
  send(message: string, opts?: unknown): AsyncIterable<SdkEvent>;
  approvePermission(id: string, decision: string): void;
  interrupt(): void;
  history?(): Turn[];
  dispose(): Promise<void>;
}

function toSdkTool(tool: ToolDef): unknown {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (args: unknown, sdkCtx: unknown) => tool.handler(args, sdkCtx as never),
  };
}

class CopilotHarnessSession implements HarnessSession {
  constructor(private readonly sdkSession: SdkSession) {}

  async *send(
    message: string,
    opts?: { attachments?: Attachment[] },
  ): AsyncIterable<HarnessEvent> {
    for await (const evt of this.sdkSession.send(message, opts)) {
      const mapped = mapSdkEvent(evt);
      if (mapped) yield mapped;
    }
  }

  approvePermission(id: string, decision: PermissionDecision): void {
    this.sdkSession.approvePermission(id, decision);
  }

  interrupt(): void {
    this.sdkSession.interrupt();
  }

  history(): Turn[] {
    return this.sdkSession.history?.() ?? [];
  }

  async dispose(): Promise<void> {
    await this.sdkSession.dispose();
  }
}

function mapSdkEvent(evt: SdkEvent): HarnessEvent | undefined {
  switch (evt.type) {
    case 'text':
      return { type: 'text', delta: String(evt.delta ?? '') };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: String(evt.id),
        name: String(evt.name),
        input: evt.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: String(evt.id),
        output: evt.output,
        isError: Boolean(evt.isError),
      };
    case 'permission_request':
      return {
        type: 'permission_request',
        request: {
          id: String(evt.id),
          tool: String(evt.tool),
          input: evt.input,
          reason: evt.reason as string | undefined,
        },
      };
    case 'turn_done':
      return { type: 'turn_done', usage: evt.usage as never };
    case 'error':
      return {
        type: 'error',
        error: {
          name: String((evt.error as { name?: string })?.name ?? 'Error'),
          message: String((evt.error as { message?: string })?.message ?? evt.error),
          stack: (evt.error as { stack?: string })?.stack,
        },
      };
    default:
      return undefined;
  }
}
