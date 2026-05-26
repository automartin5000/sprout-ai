import type {
  Attachment,
  HarnessAdapter,
  HarnessEvent,
  HarnessSession,
  PermissionDecision,
  StartSessionOpts,
  Turn,
} from './types.js';

/**
 * Token provider — kept for backwards-compat with the constructor surface,
 * but unused by the current SDK. The SDK auto-spawns the user's local
 * `copilot` CLI binary which handles its own GitHub auth (device flow on
 * first run).
 */
export type CopilotTokenProvider = () => Promise<string>;

/**
 * Adapter for the GitHub Copilot SDK (`@github/copilot-sdk`).
 *
 * The SDK is a TypeScript wrapper around the `copilot` CLI binary over
 * JSON-RPC. It auto-spawns the CLI in the background when you create a
 * `CopilotClient`, so the adapter doesn't need to handle auth, model
 * selection, or process lifecycle directly — those all live inside the
 * CLI. We just translate the SDK's event stream into Sprout's
 * `HarnessEvent` shape.
 *
 * Why dynamic import: the SDK loads the JSON-RPC connection lib eagerly,
 * which pulls in a chunk of Node-only code. Keeping it behind a dynamic
 * import means the rest of the renderer/main bundle doesn't depend on
 * the SDK being installed — useful for CI environments that don't have
 * the Copilot CLI on PATH (the SDK would fail to spawn the server).
 */
type CopilotSdkModule = typeof import('@github/copilot-sdk');

let cachedSdkModule: CopilotSdkModule | undefined;
async function loadSdk(): Promise<CopilotSdkModule> {
  if (cachedSdkModule) return cachedSdkModule;
  const mod = await import(/* @vite-ignore */ '@github/copilot-sdk' as string).catch((err: unknown) => {
    throw new Error(
      `Copilot SDK not loadable: ${(err as Error)?.message ?? err}. ` +
      'Install with `bun add @github/copilot-sdk` and make sure the `copilot` ' +
      'binary is on your PATH (the SDK spawns it as a subprocess).',
    );
  });
  cachedSdkModule = mod as CopilotSdkModule;
  return cachedSdkModule;
}

export class CopilotAdapter implements HarnessAdapter {
  readonly id = 'copilot';
  private cachedClient: CopilotClientLike | undefined;

  constructor(
    private readonly opts: {
      tokenProvider: CopilotTokenProvider;
      defaultModel?: string;
    },
  ) {}

  async startSession(opts: StartSessionOpts): Promise<HarnessSession> {
    const sdk = await loadSdk();

    // One CopilotClient per process — spawning a CLI server per session
    // is wasteful (each spawn takes 1–2s to handshake) and the SDK was
    // designed for many sessions per client.
    //
    // Pass `env: process.env` explicitly. The SDK defaults to inheriting
    // process.env when `env` isn't set, but the constructor captures the
    // env REFERENCE at construct time. By passing it explicitly we make
    // the intent obvious AND ensure any env vars Sprout sets just
    // before this (CLAUDE_PLUGIN_ROOT, SPROUT_PLUGIN_ROOT — see
    // services.ts:409) propagate to the CLI subprocess at spawn time.
    if (!this.cachedClient) {
      this.cachedClient = new sdk.CopilotClient({ env: process.env }) as unknown as CopilotClientLike;
    }

    // CRITICAL: pass `workingDirectory`, NOT `cwd`. `cwd` is a
    // CopilotClientOptions field (sets the CLI subprocess's pwd at
    // spawn time); `workingDirectory` is the SessionConfig field that
    // scopes the session's tool operations. Mixing them up means the
    // CLI runs from the right place but tools edit files in Sprout's
    // own directory — silent disaster.
    //
    // `systemMessage: { mode: 'append', content: ... }` layers
    // Sprout's project-specific guidance on top of the SDK's default
    // system message. Without it, Copilot has no idea it's working on
    // a Sprout project, what file conventions to follow, that it's
    // talking to a non-technical user, etc. — and you get generic
    // "what's this for? what theme? what format?" responses with no
    // awareness of the existing project context.
    //
    // `onElicitationRequest` auto-declines any interactive prompt
    // request the CLI server might make. Sprout's UX model is "the AI
    // never asks the user clarifying questions" — declining means
    // Copilot falls back to its best-guess defaults instead of hanging
    // on a form dialog we don't render.
    //
    // `approveAll` for permissions matches the Claude adapter's
    // current behavior on unguarded sessions. Replace with a renderer-
    // hooked handler when Sprout's permission UI lands.
    const session = await this.cachedClient.createSession({
      model: opts.model ?? this.opts.defaultModel,
      workingDirectory: opts.projectRoot,
      systemMessage: opts.systemPrompt
        ? { mode: 'append', content: opts.systemPrompt }
        : undefined,
      onPermissionRequest: sdk.approveAll,
      onElicitationRequest: () => ({ action: 'decline' as const }),
    }) as unknown as CopilotSessionLike;

    return new CopilotHarnessSession(session);
  }

  async dispose(): Promise<void> {
    if (this.cachedClient) {
      try { await this.cachedClient.stop(); } catch { /* idempotent shutdown */ }
      this.cachedClient = undefined;
    }
  }
}

/* ── Local subset of the SDK's runtime shape ──────────────────────
 *
 * We don't import the SDK's classes for types — the dynamic import means
 * the SDK might not be installed at typecheck time on every machine.
 * These interfaces describe just the surface we touch.
 */

interface CopilotClientLike {
  createSession(opts: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

interface CopilotSessionLike {
  send(opts: { prompt: string }): Promise<string>;
  on(handler: (event: SessionEventLike) => void): () => void;
  disconnect(): Promise<void>;
}

interface SessionEventLike {
  type: string;
  data?: Record<string, unknown> & {
    deltaContent?: string;
    content?: string;
    // tool.execution_start / .complete
    toolName?: string;
    toolCallId?: string;
    arguments?: Record<string, unknown>;
    success?: boolean;
    result?: unknown;
  };
}

/** Exported for unit-test access — the test file constructs an instance
 *  directly with a fake CopilotSessionLike to verify event mapping
 *  without spinning up the real CLI. Production code reaches this class
 *  via `CopilotAdapter.startSession()`. */
export class CopilotHarnessSession implements HarnessSession {
  /** Buffered events accumulated between `send()` calls. Drained lazily
   *  by the async iterator. */
  private queue: HarnessEvent[] = [];
  /** Pending resolver waiting for the next queued event. */
  private pendingResolve: ((evt: HarnessEvent | null) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private interrupted = false;
  private readonly turns: Turn[] = [];
  /** Text content streamed to the renderer in the current turn. Reset on
   *  `turn_start`. Used to compute a suffix-diff when the final
   *  `assistant.message` arrives, so we don't double-emit content that
   *  already came through as deltas. */
  private streamedThisTurn = '';
  /** Names of tools the agent invoked in the current turn. Used for the
   *  empty-turn fallback text — when Copilot does file edits silently
   *  without saying anything, we synthesize a "Done — ran X, Y" summary
   *  so the user sees feedback. */
  private toolsUsedThisTurn: string[] = [];

  constructor(private readonly sdkSession: CopilotSessionLike) {
    // One subscription for the session lifetime. Each event is mapped
    // into a HarnessEvent and either resolved to a waiting consumer or
    // queued for later. The async iterator below pumps from this queue.
    this.unsubscribe = sdkSession.on((evt) => this.handleSdkEvent(evt));
  }

  async *send(
    message: string,
    _opts?: { attachments?: Attachment[] },
  ): AsyncIterable<HarnessEvent> {
    this.interrupted = false;

    // Kick off the SDK request. We don't await this here — the response
    // streams in via the `on()` subscription and gets demuxed by
    // handleSdkEvent. Awaiting would just block until the turn ends.
    const sendPromise = this.sdkSession.send({ prompt: message });
    let turnError: unknown;
    sendPromise.catch((err: unknown) => { turnError = err; });

    while (true) {
      const evt = await this.next();
      if (evt === null) {
        // Channel closed (session disconnected). Emit a terminal turn_done
        // so the renderer doesn't hang.
        yield { type: 'turn_done' };
        return;
      }
      yield evt;
      if (evt.type === 'turn_done' || evt.type === 'error') {
        return;
      }
      if (this.interrupted) {
        yield { type: 'turn_done' };
        return;
      }
    }
  }

  approvePermission(_id: string, _decision: PermissionDecision): void {
    // Permission requests are answered via the `onPermissionRequest`
    // callback passed at createSession time, not via this method. The
    // method exists to satisfy the HarnessSession interface; future
    // work: thread the UI permission flow through to that callback.
  }

  interrupt(): void {
    this.interrupted = true;
    // Best-effort: signal completion to anyone iterating.
    this.pushEvent({ type: 'turn_done' });
  }

  history(): Turn[] {
    return [...this.turns];
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { await this.sdkSession.disconnect(); } catch { /* already gone */ }
  }

  /**
   * Demux an SDK event into a HarnessEvent (or skip it). The SDK has
   * dozens of event types — we cherry-pick the ones the chat UI cares
   * about: text deltas, completion, errors. Tool events would land here
   * as well once the permission UI is wired up.
   *
   * Text-streaming model: the SDK emits either
   *   (a) `message_start` → `message_delta`* → `message` → `turn_end`
   *       (streaming case, classic token-by-token)
   *   (b) just `message` → `turn_end`
   *       (non-streaming model — the Copilot CLI does this for some
   *       reasoning-heavy models that don't expose mid-flight tokens)
   *
   * To support both without double-emitting, we track `streamedThisTurn`:
   * deltas append to it (and emit text), and the final `assistant.message`
   * emits only the suffix that wasn't already streamed. If no deltas
   * came through (case b), the entire message content is emitted as one
   * text event — the user sees the response land all at once, but at
   * least it lands.
   */
  private handleSdkEvent(evt: SessionEventLike): void {
    switch (evt.type) {
      case 'assistant.turn_start':
        // Outer boundary: reset both the streamed-text buffer AND the
        // tools-used tracker so the empty-turn fallback only summarizes
        // tools from THIS turn.
        this.streamedThisTurn = '';
        this.toolsUsedThisTurn = [];
        break;
      case 'assistant.message_start':
        // Inner boundary: only reset the text buffer (some models emit
        // multiple messages per turn). Tools-used persists across all
        // messages within the turn.
        this.streamedThisTurn = '';
        break;
      case 'tool.execution_start': {
        // The agent invoked a tool. Map to a HarnessEvent.tool_use so
        // the renderer can show the action card. Also record the tool
        // name for the empty-turn fallback summary.
        //
        // Filter out NOISE tools — these are metadata-only callbacks
        // Copilot uses to declare intent or report progress, NOT actual
        // operations. Showing them in the action card adds clutter
        // ("report_intent ✓") that users read as gibberish, and they
        // inflate the "Done — used N tools" summary with non-actions.
        const toolName = evt.data?.toolName;
        const id = evt.data?.toolCallId;
        if (typeof toolName === 'string' && typeof id === 'string' && !isNoiseTool(toolName)) {
          this.toolsUsedThisTurn.push(toolName);
          this.pushEvent({
            type: 'tool_use',
            id,
            name: toolName,
            input: evt.data?.arguments ?? {},
          });
        }
        break;
      }
      case 'tool.execution_complete': {
        const id = evt.data?.toolCallId;
        // Only emit results for tools we surfaced (filtered noise tools
        // never got a tool_use event; emitting their result would create
        // an orphan).
        const toolName = evt.data?.toolName;
        if (
          typeof id === 'string' &&
          (typeof toolName !== 'string' || !isNoiseTool(toolName))
        ) {
          this.pushEvent({
            type: 'tool_result',
            id,
            output: evt.data?.result ?? null,
            isError: evt.data?.success === false,
          });
        }
        break;
      }
      case 'assistant.message_delta': {
        const delta = evt.data?.deltaContent;
        if (typeof delta === 'string' && delta.length > 0) {
          this.streamedThisTurn += delta;
          this.pushEvent({ type: 'text', delta });
        }
        break;
      }
      case 'assistant.message': {
        // The final, full assistant content. Emit whatever wasn't
        // already streamed (handles both the streaming and
        // non-streaming cases). Also record the turn in history.
        const content = evt.data?.content;
        if (typeof content === 'string') {
          const suffix = content.startsWith(this.streamedThisTurn)
            ? content.slice(this.streamedThisTurn.length)
            : content; // streamed content drifted from final — emit the whole thing rather than guess
          if (suffix.length > 0) {
            this.pushEvent({ type: 'text', delta: suffix });
          }
          this.streamedThisTurn = content;
          this.turns.push({
            turnId: `copilot-${Date.now()}`,
            role: 'assistant',
            content,
            ts: new Date().toISOString(),
          });
        }
        break;
      }
      case 'assistant.turn_end': {
        // Empty-turn fallback: Copilot in agentic mode sometimes does
        // file edits and ends without emitting any assistant.message at
        // all — leaving the chat with a save point but no visible
        // response. If we got here without streaming any text, emit a
        // short summary so the user sees that something happened.
        if (this.streamedThisTurn.length === 0) {
          const summary = this.toolsUsedThisTurn.length > 0
            ? `Done — ${summarizeTools(this.toolsUsedThisTurn)}.`
            : 'Done.';
          this.pushEvent({ type: 'text', delta: summary });
        }
        this.pushEvent({ type: 'turn_done' });
        this.streamedThisTurn = '';
        this.toolsUsedThisTurn = [];
        break;
      }
      case 'session.error':
      case 'model.call_failure':
      case 'abort': {
        const msg = typeof evt.data?.content === 'string'
          ? evt.data.content
          : `${evt.type}`;
        this.pushEvent({
          type: 'error',
          error: { name: evt.type, message: msg },
        });
        break;
      }
      // Everything else (capability negotiations, hook lifecycle, ui
      // dialogs, etc.) is intentionally dropped — none of it maps to a
      // user-visible chat event today. Add cases as we surface more
      // features in the renderer.
      default:
        break;
    }
  }

  private pushEvent(evt: HarnessEvent): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      resolve(evt);
    } else {
      this.queue.push(evt);
    }
  }

  private next(): Promise<HarnessEvent | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise<HarnessEvent | null>((resolve) => {
      this.pendingResolve = resolve;
    });
  }
}

/**
 * Tools that don't represent actual work — they're metadata-only callbacks
 * the agent uses to declare intent or surface progress. Showing them in
 * the action card adds clutter the non-technical user can't parse
 * ("report_intent ✓" reads as gibberish), and they pollute the "Done —
 * used N tools" summary with non-actions.
 *
 * If you add to this list, double-check the tool truly has no
 * file/shell side effect — otherwise you'll be hiding real work from
 * the user.
 */
const NOISE_TOOLS = new Set([
  'report_intent',
  'report_progress',
]);

function isNoiseTool(name: string): boolean {
  return NOISE_TOOLS.has(name);
}

/**
 * Build a short plain-English summary of which tools the agent used. Used
 * for the empty-turn fallback ("Done — edited 3 files, ran 1 shell
 * command."). Group by tool name + count so the line stays short even when
 * the agent makes many calls.
 *
 * Names are taken from the Copilot CLI's tool catalogue (str_replace_editor,
 * bash, glob, etc.). The mapping here uses friendly verbs the non-technical
 * user will recognize.
 */
function summarizeTools(toolNames: string[]): string {
  // Phrase verbs per known tool. Anything we don't recognize falls through
  // as a generic "used <count> tools" line.
  const verbs: Record<string, string> = {
    str_replace_editor: 'edited files',
    edit_file: 'edited files',
    write: 'wrote files',
    create_file: 'wrote files',
    read_file: 'read files',
    bash: 'ran shell commands',
    shell: 'ran shell commands',
    glob: 'searched files',
    grep: 'searched files',
    find: 'searched files',
    list_dir: 'looked around',
  };
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const verb = verbs[name] ?? 'used a tool';
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  // Join into "edited files (3), ran shell commands (1)" — keep brief.
  const parts: string[] = [];
  for (const [verb, n] of counts) {
    parts.push(n > 1 ? `${verb} (${n})` : verb);
  }
  return parts.join(', ');
}
