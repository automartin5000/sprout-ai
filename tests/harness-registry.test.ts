/**
 * Tests for HarnessRegistry — specifically the conditional CopilotAdapter
 * registration. Two things must hold:
 *
 *   1. When `@github/copilot-sdk` isn't installed, the registry doesn't
 *      register the copilot adapter — it doesn't appear in `list()` or
 *      pass `isAvailable()`. This avoids the "AI dropdown offers Copilot
 *      but every chat throws" failure mode.
 *   2. `defaultAdapterId()` doesn't suggest copilot when it isn't
 *      registered.
 *
 * Note: `@github/copilot-sdk` IS in the repo's package.json (as of Phase 6),
 * so on a normal dev machine the SDK *is* loadable and copilot will register.
 * The tests environmentally probe and adjust expectations.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { HarnessRegistry } from '../app/main/harness/registry.js';

function isSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('@github/copilot-sdk');
    return true;
  } catch {
    return false;
  }
}

describe('HarnessRegistry — conditional Copilot registration', () => {
  it('matches copilot registration to SDK install state', () => {
    const reg = new HarnessRegistry({ copilotTokenProvider: async () => '' });
    if (isSdkInstalled()) {
      expect(reg.isAvailable('copilot')).toBe(true);
      expect(reg.list()).toContain('copilot');
    } else {
      expect(reg.isAvailable('copilot')).toBe(false);
      expect(reg.list()).not.toContain('copilot');
    }
  });

  it('always registers claude + mock regardless of copilot status', () => {
    const reg = new HarnessRegistry({ copilotTokenProvider: async () => '' });
    expect(reg.list()).toContain('claude');
    expect(reg.list()).toContain('mock');
  });

  it('defaultAdapterId picks copilot when the SDK is loadable', () => {
    const reg = new HarnessRegistry({ copilotTokenProvider: async () => '' });
    if (isSdkInstalled()) {
      // SDK self-authenticates via the bundled `copilot` CLI's device-flow
      // login, so we no longer require a GH_TOKEN env var to pick it.
      expect(reg.defaultAdapterId()).toBe('copilot');
    } else {
      // Without the SDK, registry must not suggest copilot — even if a
      // stale token env var would otherwise prefer it.
      expect(reg.defaultAdapterId()).not.toBe('copilot');
    }
  });

  it('throws on get() for an unregistered adapter', () => {
    const reg = new HarnessRegistry({ copilotTokenProvider: async () => '' });
    if (isSdkInstalled()) {
      expect(() => reg.get('not-a-real-adapter')).toThrow(/unknown harness/);
    } else {
      expect(() => reg.get('copilot')).toThrow(/unknown harness/);
    }
  });
});
