import { v4 as uuid } from 'uuid';
import type {
  Attachment,
  HarnessAdapter,
  HarnessEvent,
  HarnessSession,
  PermissionDecision,
  PermissionRequest,
  StartSessionOpts,
  Turn,
} from './types.js';

/**
 * Adapter for the official Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
 *
 * The SDK is loaded dynamically so a missing/optional install never breaks
 * the main bundle. The whole SDK surface lives behind this file — no other
 * module touches @anthropic-ai/* directly.
 */

type ClaudeSdkModule = {
  query: (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => AsyncGenerator<unknown> & {
    interrupt(): Promise<void>;
    setPermissionMode?: (mode: string) => Promise<void>;
  };
  tool?: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
  ) => unknown;
};

let cachedSdkModule: ClaudeSdkModule | undefined;
async function loadSdk(): Promise<ClaudeSdkModule> {
  if (cachedSdkModule) return cachedSdkModule;
  cachedSdkModule = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as ClaudeSdkModule;
  return cachedSdkModule;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude';

  constructor(
    private readonly opts: {
      /**
       * Optional explicit API key override. If unset, the SDK falls back to:
       *   1. `ANTHROPIC_API_KEY` env var, then
       *   2. `claude login` OAuth credentials stored in the OS keychain
       *      (macOS: Keychain entry "Claude Code-credentials", same place
       *      the `claude` CLI keeps them).
       * So if you've already run `claude login` on this machine, no key is
       * required.
       */
      apiKeyProvider?: () => Promise<string | undefined>;
      defaultModel?: string;
    } = {},
  ) {}

  async startSession(opts: StartSessionOpts): Promise<HarnessSession> {
    const apiKey = (await this.opts.apiKeyProvider?.()) ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = apiKey;
    }
    // No assertion: the SDK reads keychain OAuth creds when no key is set.
    return new ClaudeHarnessSession(opts, this.opts.defaultModel);
  }

  async dispose(): Promise<void> {
    /* sessions own their own queries */
  }
}

/**
 * The Claude Agent SDK is built around `query()`, a single async-iterator
 * call. To present a multi-turn `send()` API, we feed the SDK a streaming
 * prompt via an async-iterable generator that we push into from outside.
 */
class ClaudeHarnessSession implements HarnessSession {
  private readonly _history: Turn[] = [];
  private readonly pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();
  private readonly inputQueue: Array<{ message: string; resolve: () => void }> = [];
  private inputResolvers: Array<(v: { value: unknown; done: boolean }) => void> = [];
  private currentQuery?: ReturnType<ClaudeSdkModule['query']>;
  private aborted = false;

  constructor(
    private readonly opts: StartSessionOpts,
    private readonly defaultModel: string | undefined,
  ) {}

  async *send(
    message: string,
    _opts?: { attachments?: Attachment[] },
  ): AsyncIterable<HarnessEvent> {
    this._history.push({
      turnId: uuid(),
      role: 'user',
      content: message,
      ts: new Date().toISOString(),
    });

    const sdk = await loadSdk();

    // Build the options bag once per send() so model/permission overrides
    // applied between turns are honoured.
    const sdkOptions = {
      cwd: this.opts.projectRoot,
      model: this.opts.model ?? this.defaultModel,
      systemPrompt: this.opts.systemPrompt,
      // Skills + agents map directly to filesystem paths / inline dicts.
      // We pass agent definitions inline (Claude SDK wants a dict, not paths).
      agents: this.buildAgentsDict(),
      settingSources: ['user', 'project'],
      canUseTool: this.buildCanUseTool(),
      includePartialMessages: true,
      // Sprout's UX model is "the AI never asks the non-technical user
      // questions — it makes reasonable choices itself". Banning Claude
      // Code's built-in AskUserQuestion tool forces the model to commit
      // instead of stalling the conversation waiting for an answer card
      // that our renderer doesn't (yet) display. If we ever surface
      // user-facing questions, drop this and add answer routing.
      disallowedTools: ['AskUserQuestion'],
    } as Record<string, unknown>;

    const query = sdk.query({ prompt: message, options: sdkOptions });
    this.currentQuery = query;
    this.aborted = false;

    try {
      for await (const sdkMsg of query) {
        const events = mapSdkMessage(sdkMsg);
        for (const evt of events) yield evt;
        if (this.aborted) break;
      }
    } catch (err) {
      yield {
        type: 'error',
        error: {
          name: (err as Error).name ?? 'Error',
          message: (err as Error).message ?? String(err),
          stack: (err as Error).stack,
        },
      };
    } finally {
      this.currentQuery = undefined;
    }
  }

  approvePermission(id: string, decision: PermissionDecision): void {
    const resolver = this.pendingPermissions.get(id);
    if (!resolver) return;
    this.pendingPermissions.delete(id);
    resolver(decision);
  }

  interrupt(): void {
    this.aborted = true;
    void this.currentQuery?.interrupt();
    // Auto-deny any outstanding permission asks so the SDK unblocks.
    for (const [, resolver] of this.pendingPermissions) resolver('deny');
    this.pendingPermissions.clear();
  }

  history(): Turn[] {
    return [...this._history];
  }

  async dispose(): Promise<void> {
    this.interrupt();
  }

  private buildAgentsDict(): Record<string, unknown> {
    const dict: Record<string, unknown> = {};
    for (const agent of this.opts.agents) {
      dict[agent.name] = {
        description: agent.description,
        prompt: agent.body,
        tools: agent.tools.length && !agent.tools.includes('*') ? agent.tools : undefined,
      };
    }
    return dict;
  }

  /**
   * Bridge the SDK's synchronous-callback permission model into our
   * async UI-driven approval flow.
   *
   *   SDK calls canUseTool(name, input, ctx)
   *   → we emit a `permission_request` event upstream
   *   → renderer shows a prompt and calls approvePermission(id, decision)
   *   → that resolves the Promise we returned to the SDK
   */
  private buildCanUseTool() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { signal: AbortSignal },
    ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }> => {
      const request: PermissionRequest = {
        id: uuid(),
        tool: toolName,
        input,
      };

      const decision = await new Promise<PermissionDecision>((resolve) => {
        this.pendingPermissions.set(request.id, resolve);

        // Hand the request to our adapter consumer via the callback the
        // session was constructed with. The harness host wires this up to
        // an IPC event in the main process.
        void this.opts.permissionCallback(request).then(resolve);

        ctx.signal.addEventListener('abort', () => resolve('deny'));
      });

      if (decision === 'deny') {
        return { behavior: 'deny', message: 'user declined' };
      }
      return { behavior: 'allow', updatedInput: input };
    };
  }
}

/**
 * Translate one SDK message into zero or more harness events. The SDK's
 * message shape is broader than ours; we only surface the kinds the UI knows
 * how to render. Unknown kinds are silently dropped.
 */
function mapSdkMessage(raw: unknown): HarnessEvent[] {
  const msg = raw as { type?: string; subtype?: string; [k: string]: unknown };
  switch (msg.type) {
    case 'assistant': {
      const content = (msg.message as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> } | undefined)?.content;
      if (!content) return [];
      const events: HarnessEvent[] = [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          events.push({ type: 'text', delta: block.text });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            id: String(block.id ?? uuid()),
            name: String(block.name ?? 'unknown'),
            input: block.input,
          });
        }
      }
      return events;
    }
    case 'user': {
      const content = (msg.message as { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } | undefined)?.content;
      if (!content) return [];
      const events: HarnessEvent[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            id: String(block.tool_use_id ?? ''),
            output: block.content,
            isError: Boolean(block.is_error),
          });
        }
      }
      return events;
    }
    case 'result': {
      return [{ type: 'turn_done' }];
    }
    case 'stream_event':
    case 'system':
    case 'partial_assistant':
      return [];
    default:
      return [];
  }
}
