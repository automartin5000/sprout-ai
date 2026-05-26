import { createRequire } from 'node:module';
import type { HarnessAdapter } from './types.js';
import { CopilotAdapter, type CopilotTokenProvider } from './copilot-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { MockAdapter } from './mock-adapter.js';

export interface HarnessRegistryOpts {
  copilotTokenProvider: CopilotTokenProvider;
  /** Optional override for ANTHROPIC_API_KEY (defaults to env). */
  claudeApiKeyProvider?: () => Promise<string | undefined>;
  defaultModel?: string;
}

/**
 * Resolve `@github/copilot-sdk` without loading it. The SDK is a real npm
 * package (TypeScript wrapper around the `copilot` CLI binary via JSON-RPC),
 * but it can be absent in two distinct ways:
 *
 *   1. The npm package itself isn't installed.
 *   2. The package IS installed but the `copilot` CLI binary isn't on PATH
 *      — in that case the SDK loads fine but `new CopilotClient()` will
 *      fail to spawn its server at session-create time.
 *
 * This probe checks case 1 only. We register the adapter optimistically
 * when the package is present; runtime failures from case 2 surface as
 * error events in the chat UI with a clear message ("install the copilot
 * binary from cli.github.com").
 */
function isCopilotSdkInstalled(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('@github/copilot-sdk');
    return true;
  } catch {
    return false;
  }
}

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  constructor(private readonly opts: HarnessRegistryOpts) {
    // Only register Copilot if @github/copilot-sdk is installed. The SDK
    // is a real npm package (TypeScript wrapper around the `copilot` CLI
    // via JSON-RPC). If it's missing the AI dropdown wouldn't show
    // "Copilot" at all — keeping the UI honest. If the package is there
    // but the `copilot` binary isn't on PATH, the adapter loads at boot
    // but session creation fails with a clear error in the chat.
    if (isCopilotSdkInstalled()) {
      this.register(new CopilotAdapter({
        tokenProvider: opts.copilotTokenProvider,
        defaultModel: opts.defaultModel,
      }));
    }
    this.register(new ClaudeAdapter({
      apiKeyProvider: opts.claudeApiKeyProvider,
      defaultModel: opts.defaultModel,
    }));
    this.register(new MockAdapter());
  }

  /** Whether an adapter is currently registered (and therefore usable). */
  isAvailable(id: string): boolean {
    return this.adapters.has(id);
  }

  /**
   * Pick a sensible default adapter based on which tooling the user
   * actually has installed. Order:
   *   1. Copilot — if @github/copilot-sdk is installed. The SDK
   *                self-authenticates via the bundled `copilot` CLI
   *                (GitHub device-flow login on first run), so we don't
   *                need a token env var to gate this anymore.
   *   2. Claude  — if ANTHROPIC_API_KEY set OR Claude Code is installed
   *                (the SDK reads `claude login` OAuth creds from the
   *                OS keychain, so an installed+logged-in Claude Code
   *                is enough to authenticate).
   *   3. Mock    — otherwise.
   *
   * We use `~/.claude/` existing as a cheap proxy for "Claude Code installed";
   * the SDK itself handles the actual keychain lookup at session start.
   */
  defaultAdapterId(): string {
    if (this.adapters.has('copilot')) {
      return 'copilot';
    }
    if (this.adapters.has('claude')) {
      if (process.env.ANTHROPIC_API_KEY) return 'claude';
      try {
        // Lazy require so the renderer doesn't pull node:fs.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        const os = require('node:os') as typeof import('node:os');
        const path = require('node:path') as typeof import('node:path');
        if (fs.existsSync(path.join(os.homedir(), '.claude'))) {
          return 'claude';
        }
      } catch {
        /* ignore — fall through to mock */
      }
    }
    return 'mock';
  }

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`unknown harness adapter: ${id}`);
    }
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()));
  }
}
