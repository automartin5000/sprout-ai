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
 * Resolve `@github/copilot-sdk` without loading it. The SDK is a heavy native
 * dep we never want to import eagerly; this just confirms it's installed so
 * we don't register an adapter that will throw on every chat message.
 *
 * Returns false when the SDK isn't on disk — including the common case where
 * the user has only `@anthropic-ai/claude-agent-sdk` installed.
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
    // Only register Copilot if its SDK is actually installed. Otherwise the
    // adapter shows up in the AI dropdown but every chat message fails with
    // "copilot SDK not available". Filtering at registration time keeps the
    // UI honest — Copilot only appears as an option when it can actually
    // run.
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
   * Pick a sensible default adapter based on which credentials the user
   * actually has available. Order:
   *   1. Copilot — if GH token set
   *   2. Claude  — if ANTHROPIC_API_KEY set OR Claude Code is installed
   *                (the SDK reads `claude login` OAuth creds from the OS
   *                keychain, so an installed+logged-in Claude Code is
   *                enough to authenticate)
   *   3. Mock    — otherwise
   *
   * We use `~/.claude/` existing as a cheap proxy for "Claude Code installed";
   * the SDK itself handles the actual keychain lookup at session start.
   */
  defaultAdapterId(): string {
    // Copilot only counts if its SDK is actually loadable AND the user has
    // a GH token. Without the SDK the adapter isn't even registered, so
    // returning 'copilot' here would point users at a non-existent option.
    if (
      this.adapters.has('copilot') &&
      (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    ) {
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
