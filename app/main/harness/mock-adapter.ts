import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessSession,
  PermissionDecision,
  StartSessionOpts,
  Turn,
} from './types.js';

/**
 * Trivial echo adapter used in tests and the renderer's "no SDK token yet"
 * placeholder. Mirrors the public adapter contract without touching the
 * Copilot SDK at all.
 */
export class MockAdapter implements HarnessAdapter {
  readonly id = 'mock';

  async startSession(opts: StartSessionOpts): Promise<HarnessSession> {
    return new MockSession(opts.projectRoot);
  }

  async dispose(): Promise<void> {
    /* nothing to clean */
  }
}

class MockSession implements HarnessSession {
  private readonly _history: Turn[] = [];
  constructor(private readonly projectRoot: string) {}

  async *send(message: string): AsyncIterable<HarnessEvent> {
    this._history.push({
      turnId: `mock-${Date.now()}`,
      role: 'user',
      content: message,
      ts: new Date().toISOString(),
    });

    yield { type: 'text', delta: `[mock harness] received in ${this.projectRoot}: ` };
    yield { type: 'text', delta: message };
    yield { type: 'turn_done' };
  }

  approvePermission(_id: string, _decision: PermissionDecision): void {}
  interrupt(): void {}
  history(): Turn[] {
    return [...this._history];
  }
  async dispose(): Promise<void> {}
}
