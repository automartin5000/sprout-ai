/**
 * Tests for CopilotHarnessSession's SDK event → HarnessEvent mapping.
 *
 * The bug this test pins (Phase 6 follow-up): when the Copilot CLI runs
 * a non-streaming model, it emits only the final `assistant.message`
 * event — NOT any `assistant.message_delta` events. The old adapter
 * only mapped deltas → `text`, so the user saw an empty assistant
 * bubble and a save point with no content.
 *
 * The fix tracks `streamedThisTurn` and emits a suffix-diff on the
 * final `assistant.message`, so non-streaming responses still land.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CopilotHarnessSession } from '../app/main/harness/copilot-adapter.js';
import type { HarnessEvent } from '../app/main/harness/types.js';

interface FakeSession {
  send: (opts: { prompt: string }) => Promise<string>;
  on: (handler: (evt: { type: string; data?: Record<string, unknown> }) => void) => () => void;
  disconnect: () => Promise<void>;
  /** Test hook — manually inject an event into the subscriber stream. */
  emit: (type: string, data?: Record<string, unknown>) => void;
}

/** Build a fake CopilotSessionLike whose events we drive manually. */
function makeFakeSession(): FakeSession {
  let handler: ((evt: { type: string; data?: Record<string, unknown> }) => void) | undefined;
  return {
    send: async () => 'mock-message-id',
    on: (h) => {
      handler = h;
      return () => { handler = undefined; };
    },
    disconnect: async () => undefined,
    emit: (type, data) => handler?.({ type, data }),
  };
}

/** Pump a HarnessEvent AsyncIterable into an array, stopping at turn_done
 *  or error. */
async function collect(iter: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (e.type === 'turn_done' || e.type === 'error') break;
  }
  return out;
}

describe('CopilotHarnessSession event mapping', () => {
  let fake: FakeSession;
  let session: CopilotHarnessSession;

  beforeEach(() => {
    fake = makeFakeSession();
    // CopilotHarnessSession takes a CopilotSessionLike — our fake matches
    // the shape.
    session = new CopilotHarnessSession(fake as never);
  });

  afterEach(async () => {
    await session.dispose();
  });

  it('streams text deltas in the streaming case', async () => {
    const iterator = session.send('test prompt');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.message_start', { messageId: 'm1' });
    fake.emit('assistant.message_delta', { deltaContent: 'Hello' });
    fake.emit('assistant.message_delta', { deltaContent: ', world!' });
    fake.emit('assistant.message', { content: 'Hello, world!' });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;
    const textPieces = events
      .filter((e): e is { type: 'text'; delta: string } => e.type === 'text')
      .map((e) => e.delta);
    expect(textPieces.join('')).toBe('Hello, world!');
    // Deltas + final message: deltas emit "Hello" + ", world!"; final
    // message's content equals what we streamed, so its suffix is empty
    // and no extra text event fires. Total: 2 text events.
    expect(textPieces).toEqual(['Hello', ', world!']);
    expect(events[events.length - 1].type).toBe('turn_done');
  });

  it('emits the full message as text when no deltas were sent (non-streaming case)', async () => {
    // This is the user-reported failure: save point landed, no text.
    const iterator = session.send('test prompt');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    // CLI emits ONLY the final message — no deltas.
    fake.emit('assistant.message', { content: 'Here is your response.' });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;
    const textPieces = events
      .filter((e): e is { type: 'text'; delta: string } => e.type === 'text')
      .map((e) => e.delta);
    expect(textPieces).toEqual(['Here is your response.']);
    expect(events[events.length - 1].type).toBe('turn_done');
  });

  it('does not double-emit when streamed text exactly matches the final message', async () => {
    // Regression: if the suffix-diff logic was buggy, the final message
    // would emit a duplicate copy of the full content after deltas had
    // already landed.
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.message_delta', { deltaContent: 'foo' });
    fake.emit('assistant.message_delta', { deltaContent: 'bar' });
    fake.emit('assistant.message', { content: 'foobar' });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;
    const concatenated = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(concatenated).toBe('foobar');
  });

  it('emits a "Done — …" fallback when agent ends with no text but ran tools', async () => {
    // Silent-agentic case: Copilot does file edits and never says anything.
    // Before this guard the chat showed an empty assistant bubble.
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.turn_start', { turnId: 't1' });
    fake.emit('tool.execution_start', {
      toolName: 'str_replace_editor', toolCallId: 'tc1', arguments: { path: 'a.css' },
    });
    fake.emit('tool.execution_complete', { toolCallId: 'tc1', success: true });
    fake.emit('tool.execution_start', {
      toolName: 'bash', toolCallId: 'tc2', arguments: { command: 'npm run build' },
    });
    fake.emit('tool.execution_complete', { toolCallId: 'tc2', success: true });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;

    // Tool events surfaced for the renderer's action card.
    expect(events.some((e) => e.type === 'tool_use' && e.name === 'str_replace_editor')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use' && e.name === 'bash')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.id === 'tc1')).toBe(true);

    // Fallback text mentions what the agent did.
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toContain('Done');
    expect(text).toContain('edited files');
    expect(text).toContain('ran shell commands');
  });

  it('skips the fallback when the assistant DID provide text', async () => {
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.turn_start', { turnId: 't1' });
    fake.emit('tool.execution_start', { toolName: 'bash', toolCallId: 't' });
    fake.emit('tool.execution_complete', { toolCallId: 't', success: true });
    fake.emit('assistant.message', { content: 'All set, background updated.' });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    // Only the assistant's own text; the "Done — …" fallback should be skipped.
    expect(text).toBe('All set, background updated.');
    expect(text).not.toContain('Done — ');
  });

  it('emits a plain "Done." when neither text nor tools were observed', async () => {
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.turn_start', { turnId: 't1' });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toBe('Done.');
  });

  it('filters out report_intent / report_progress noise tools', async () => {
    // Copilot uses these to declare intent before doing real work — they
    // have no file/shell side effect and shouldn't surface in the
    // action card or pollute the summary. Pre-fix, the user saw a
    // "Done — used a tool" with `report_intent` as the only "step".
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'turn_done') break;
      }
    })();

    fake.emit('assistant.turn_start', { turnId: 't1' });
    fake.emit('tool.execution_start', { toolName: 'report_intent', toolCallId: 'n1', arguments: { intent: 'I will scaffold the app' } });
    fake.emit('tool.execution_complete', { toolCallId: 'n1', toolName: 'report_intent', success: true });
    fake.emit('tool.execution_start', { toolName: 'bash', toolCallId: 'b1', arguments: { command: 'echo hi' } });
    fake.emit('tool.execution_complete', { toolCallId: 'b1', toolName: 'bash', success: true });
    fake.emit('assistant.turn_end', { turnId: 't1' });

    await reader;

    // The action-card stream only sees `bash`, not `report_intent`.
    const tools = events
      .filter((e) => e.type === 'tool_use')
      .map((e) => (e as { name: string }).name);
    expect(tools).toEqual(['bash']);

    // No orphan tool_result for the filtered tool either.
    const resultIds = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { id: string }).id);
    expect(resultIds).toEqual(['b1']);

    // Summary phrase doesn't say "used a tool" (which is what
    // report_intent USED to look like as an unknown tool).
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toBe('Done — ran shell commands.');
  });

  it('emits an error on session.error', async () => {
    const iterator = session.send('p');
    const events: HarnessEvent[] = [];
    const reader = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (e.type === 'error' || e.type === 'turn_done') break;
      }
    })();

    fake.emit('session.error', { content: 'connection dropped' });
    await reader;

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      error: { name: 'session.error', message: 'connection dropped' },
    });
  });
});
