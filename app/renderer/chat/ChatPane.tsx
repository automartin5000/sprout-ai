import React, { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../shared/api-contract.js';
import type { ChatStreamEvent } from '../global.js';

/* ── Types ──────────────────────────────────────────────────── */

interface ActionStep {
  toolUseId: string;
  label: string;
  file: string;
  state: 'pending' | 'active' | 'done';
  /** Epoch ms when the step started — used to render an elapsed timer so
   *  the user can tell that a long-running step is working, not hung. */
  startedAt: number;
  /** Epoch ms when the step finished. Surfaces "this step took N seconds"
   *  on done rows so the user can see which step was the slow one. */
  endedAt?: number;
}

interface CheckpointInfo {
  id: string;
  label: string;
  ts: string;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  actionCard?: {
    title: string;
    steps: ActionStep[];
    active: boolean; // true while the turn is still running
  };
  checkpoint?: CheckpointInfo;
}

/* ── Helpers ────────────────────────────────────────────────── */

function toolLabel(name: string, input: Record<string, unknown>): { label: string; file: string } {
  switch (name) {
    case 'Bash': {
      const desc = String(input['description'] ?? '');
      const cmd = String(input['command'] ?? '');
      return { label: desc || truncate(cmd, 48), file: '—' };
    }
    case 'Read': {
      const fp = String(input['file_path'] ?? input['path'] ?? '');
      return { label: 'Reading file', file: basename(fp) };
    }
    case 'Edit':
    case 'MultiEdit': {
      const fp = String(input['file_path'] ?? input['path'] ?? '');
      return { label: 'Editing file', file: basename(fp) };
    }
    case 'Write': {
      const fp = String(input['file_path'] ?? input['path'] ?? '');
      return { label: 'Writing file', file: basename(fp) };
    }
    case 'Glob':
    case 'Grep': {
      return { label: name === 'Glob' ? 'Scanning files' : 'Searching code', file: '—' };
    }
    case 'Skill': {
      const skill = String(input['skill'] ?? input['name'] ?? '');
      return { label: `Launching skill`, file: skill };
    }
    case 'Agent': {
      const agent = String(input['agent'] ?? input['name'] ?? '');
      return { label: `Running agent`, file: agent || '—' };
    }
    case 'Task': {
      return { label: 'Spawning task', file: '—' };
    }
    default:
      return { label: name, file: '—' };
  }
}

function inferCardTitle(name: string): string {
  switch (name) {
    case 'Bash': return 'Running commands';
    case 'Read': return 'Reading files';
    case 'Edit': case 'Write': case 'MultiEdit': return 'Editing files';
    case 'Skill': return 'Running skill';
    case 'Agent': return 'Delegating to agent';
    default: return 'Working…';
  }
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Markdown-lite: **bold**, *italic*, `code` → React nodes */
function renderInline(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function timeAgo(isoTs: string): string {
  const diff = Math.floor((Date.now() - new Date(isoTs).getTime()) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/* ── Sub-components ─────────────────────────────────────────── */

function CheckIcon(): React.ReactElement {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function PinIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function HistoryIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
    </svg>
  );
}

function SendIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}

function StopIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    </svg>
  );
}

function ActionCard({ card, active }: { card: DisplayMessage['actionCard']; active: boolean }): React.ReactElement {
  // Re-render once per second whenever there's an active step, so the
  // elapsed-time counter ticks. Inexpensive — at most one card has an
  // active step at a time.
  const [, setTick] = useState(0);
  const hasActive = card?.steps.some((s) => s.state === 'active') ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasActive]);

  if (!card) return <></>;
  return (
    <div className="action-card">
      <div className="action-card-head">
        <span className={`pulse-dot${active ? ' active' : ''}`} />
        {active
          ? <span className="shimmer">{card.title}…</span>
          : <span>{card.title}</span>
        }
      </div>
      <div>
        {card.steps.map((s, i) => (
          <div key={i} className="action-step">
            <div className={`step-check ${s.state}`}>
              {s.state === 'done' && <CheckIcon />}
            </div>
            <span>{s.label}</span>
            <span className="step-file">{stepTrailing(s)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Active-step duration display: "4s", "47s", "1m 12s", "3m 5s" */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * What to show on the right side of a step row.
 *   active           → live elapsed timer
 *   done w/ slow run → "<file> · <duration>" (so the user can see WHICH
 *                       step was slow when scanning the timeline)
 *   done w/ fast run → just the file name (durations <2s aren't interesting)
 *   pending          → file name or empty
 */
function stepTrailing(s: ActionStep): string {
  if (s.state === 'active') return formatElapsed(Date.now() - s.startedAt);
  if (s.state === 'done' && s.endedAt) {
    const ms = s.endedAt - s.startedAt;
    const slow = ms >= 2000;
    if (slow && s.file) return `${s.file} · ${formatElapsed(ms)}`;
    if (slow) return formatElapsed(ms);
    return s.file;
  }
  return s.file;
}

function CheckpointCard({ cp, userMsg }: { cp: CheckpointInfo; userMsg: string }): React.ReactElement {
  return (
    <div className="checkpoint-card" style={{ cursor: 'default' }}>
      <div className="cp-icon"><PinIcon /></div>
      <div className="cp-meta">
        <div className="cp-title">{truncate(userMsg, 36)}</div>
        <div className="cp-sub">save point · {timeAgo(cp.ts)}</div>
      </div>
      <div style={{ color: 'var(--ink-4)', display: 'flex' }}><HistoryIcon /></div>
    </div>
  );
}

/* ── Main component ─────────────────────────────────────────── */

export function ChatPane({ project }: { project?: Project }): React.ReactElement {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [isFresh, setIsFresh] = useState(false);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Track last user message text for checkpoint labels
  const lastUserMsgRef = useRef('');

  // Determine whether to show the "fresh project" hero + sample prompts.
  // Only true when the worktree is genuinely empty (no AI-written files yet).
  // Reopening a project that's already been worked on suppresses both,
  // since the hero + chips imply a fresh start and we have no chat history
  // persistence to show prior turns instead.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void window.sprout
      .invoke('projects:hasContent', { projectId: project.projectId })
      .then((hasContent) => { if (!cancelled) setIsFresh(!hasContent); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [project?.projectId]);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function autoResize(): void {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }

  async function send(): Promise<void> {
    if (!input.trim() || !project || pending) return;
    const userMessage = input.trim();
    setInput('');
    setTimeout(autoResize, 0);
    setPending(true);
    lastUserMsgRef.current = userMessage;

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content: userMessage },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ]);

    try {
      unsubscribeRef.current?.();
      const { streamChannel } = await window.sprout.invoke('chat:send', {
        projectId: project.projectId,
        message: userMessage,
      });

      let done = false;

      // Idle-timeout: declare the turn stuck only when NOTHING arrives for
      // IDLE_MS. Long turns that keep producing tool calls / text are fine;
      // truly silent ones get a friendly bail-out. This is much better than
      // a total-elapsed timer that kills a healthy turn just because
      // `npm install` happens to take 4 minutes.
      const IDLE_MS = 5 * 60_000;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const onStuck = (): void => {
        if (done) return;
        setPending(false);
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            role: 'error',
            content: 'No activity for 5 minutes — the turn may still be running in the background. Try again or send another message.',
          },
        ]);
      };
      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (!done) idleTimer = setTimeout(onStuck, IDLE_MS);
      };
      resetIdle();

      unsubscribeRef.current = window.sprout.onChatStream(
        streamChannel,
        (event: ChatStreamEvent) => {
          // Any incoming event is a sign of life — reset the idle clock.
          resetIdle();
          handleEvent(assistantId, event, () => {
            done = true;
            if (idleTimer) clearTimeout(idleTimer);
            setPending(false);
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
          });
        },
      );
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: 'error', content: String(err) },
      ]);
      setPending(false);
    }
  }

  function handleEvent(
    assistantId: string,
    event: ChatStreamEvent,
    onDone: () => void,
  ): void {
    const payload = event.payload as Record<string, unknown>;

    switch (event.type) {
      case 'text': {
        const delta = String(payload['delta'] ?? '');
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, content: msg.content + delta }
              : msg,
          ),
        );
        break;
      }

      case 'tool_use': {
        const toolName = String(payload['name'] ?? 'tool');
        const toolId = String(payload['id'] ?? crypto.randomUUID());
        const toolInput = (payload['input'] ?? {}) as Record<string, unknown>;
        const { label, file } = toolLabel(toolName, toolInput);

        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== assistantId) return msg;
            const existing = msg.actionCard;
            if (existing) {
              // Add step to existing card
              return {
                ...msg,
                actionCard: {
                  ...existing,
                  steps: [
                    ...existing.steps,
                    { toolUseId: toolId, label, file, state: 'active' as const, startedAt: Date.now() },
                  ],
                },
              };
            }
            // Create new card
            return {
              ...msg,
              actionCard: {
                title: inferCardTitle(toolName),
                active: true,
                steps: [{ toolUseId: toolId, label, file, state: 'active' as const, startedAt: Date.now() }],
              },
            };
          }),
        );
        break;
      }

      case 'tool_result': {
        const toolId = String(payload['id'] ?? '');
        const now = Date.now();
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== assistantId || !msg.actionCard) return msg;
            return {
              ...msg,
              actionCard: {
                ...msg.actionCard,
                steps: msg.actionCard.steps.map((s) =>
                  s.toolUseId === toolId || s.state === 'active'
                    ? { ...s, state: 'done' as const, endedAt: s.endedAt ?? now }
                    : s,
                ),
              },
            };
          }),
        );
        break;
      }

      case 'error': {
        const errMsg = String(
          (payload['error'] as { message?: string } | undefined)?.message ?? payload['error'] ?? 'Unknown error',
        );
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: 'error', content: errMsg },
        ]);
        onDone();
        break;
      }

      case 'turn_done': {
        // Mark assistant message as done, seal action card, add checkpoint
        const checkpointId = crypto.randomUUID();
        const ts = new Date().toISOString();
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== assistantId) return msg;
            return {
              ...msg,
              streaming: false,
              actionCard: msg.actionCard
                ? {
                    ...msg.actionCard,
                    active: false,
                    steps: msg.actionCard.steps.map((s) =>
                      s.state !== 'done'
                        ? { ...s, state: 'done' as const, endedAt: s.endedAt ?? Date.now() }
                        : s,
                    ),
                  }
                : undefined,
              checkpoint: { id: checkpointId, label: lastUserMsgRef.current, ts },
            };
          }),
        );
        onDone();
        break;
      }

      case 'permission_request':
        // Auto-allow via the canUseTool callback; no UI needed for v1
        break;
    }
  }

  function handleStop(): void {
    if (!project) return;
    void window.sprout.invoke('chat:interrupt', { projectId: project.projectId });
    setPending(false);
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    setMessages((m) =>
      m.map((msg) =>
        msg.streaming
          ? {
              ...msg,
              streaming: false,
              actionCard: msg.actionCard ? { ...msg.actionCard, active: false } : undefined,
            }
          : msg,
      ),
    );
  }

  const msgCount = messages.length;

  return (
    <section className="chat">
      {/* Header */}
      <div className="chat-head">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
          <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
        </svg>
        <div className="chat-head-title">{project?.name ?? 'sprout'}</div>
        {msgCount > 0 && (
          <div className="chat-head-meta">{msgCount} msg{msgCount !== 1 ? 's' : ''}</div>
        )}
      </div>

      {/* Messages */}
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && isFresh && (
          <div className="chat-welcome">
            <div className="chat-welcome-mark">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
                <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
              </svg>
            </div>
            <p className="chat-welcome-title">
              {project ? `Hi, I'm ${project.name}.` : 'Loading…'}
            </p>
            <p className="chat-welcome-sub">
              {project
                ? "Tell me what you'd like to build and I'll start sketching. You can talk to me like a friend — no jargon needed."
                : 'Initialising project…'}
            </p>
          </div>
        )}
        {messages.length === 0 && !isFresh && project && (
          <div className="chat-welcome" style={{ paddingTop: 32 }}>
            <p className="chat-welcome-sub" style={{ fontSize: 14 }}>
              Pick up where you left off — tell me what to change.
            </p>
          </div>
        )}

        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="msg user">
                <div className="avatar">M</div>
                <div className="msg-bubble">
                  <div className="msg-author">
                    You <span className="dot" /> just now
                  </div>
                  <div className="msg-content">{renderInline(m.content)}</div>
                </div>
              </div>
            );
          }

          if (m.role === 'error') {
            return (
              <div key={m.id} className="msg error">
                <div className="msg-bubble">
                  <div className="msg-content">{m.content}</div>
                </div>
              </div>
            );
          }

          // assistant
          return (
            <div key={m.id} className="msg sprout">
              <div className="avatar avatar-sprout" style={{ background: 'linear-gradient(135deg, var(--accent), #8c4a23)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
                  <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
                </svg>
              </div>
              <div className="msg-bubble">
                <div className="msg-author">
                  sprout <span className="dot" />
                  {m.streaming ? 'thinking…' : 'just now'}
                </div>
                <div className="msg-content">
                  {renderInline(m.content)}
                  {m.streaming && m.content === '' && (
                    <span style={{ color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 13 }}>…</span>
                  )}
                  {m.streaming && m.content !== '' && <span className="caret" />}
                </div>
                {m.actionCard && (
                  <ActionCard card={m.actionCard} active={m.actionCard.active} />
                )}
                {m.checkpoint && !m.streaming && (
                  <CheckpointCard cp={m.checkpoint} userMsg={m.checkpoint.label} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sample-app starting prompts: ONLY on a truly fresh worktree.
          Reopening a project with existing files suppresses these — the
          "Build a habit tracker" chips would be misleading when the user
          already has, say, a geoguesser. */}
      {messages.length === 0 && project && isFresh && (
        <div className="suggest-row">
          {[
            'Build a habit tracker',
            'Make a simple todo list',
            'Create a recipe organizer',
            'Build a personal blog',
          ].map((s) => (
            <button
              key={s}
              className="suggest-chip"
              onClick={() => { setInput(s); setTimeout(() => taRef.current?.focus(), 0); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="composer">
        <div className="composer-wrap">
          <textarea
            ref={taRef}
            value={input}
            disabled={!project || pending}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={project ? 'Describe what to build…' : 'Loading project…'}
            rows={1}
            style={{ minHeight: 38 }}
          />
          <div className="composer-tools">
            <div className="left" />
            <div className="right">
              {pending ? (
                <button className="stop-btn" onClick={handleStop} title="Stop">
                  <StopIcon />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={!project || !input.trim()}
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="composer-hint">
          <span><kbd className="kbd">↵</kbd> send</span>
          <span><kbd className="kbd">⇧↵</kbd> newline</span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className={`badge-dot${pending ? '' : ''}`} style={{ background: pending ? 'var(--accent)' : 'var(--ok)' }} />
            {pending ? 'working…' : 'connected'}
          </span>
        </div>
      </div>
    </section>
  );
}
