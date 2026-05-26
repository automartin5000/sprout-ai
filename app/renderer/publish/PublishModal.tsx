import React, { useEffect, useRef, useState } from 'react';
import type { PublishProgressEvent } from '../../main/ipc.js';

type Phase = 'idle' | 'building' | 'packaging' | 'uploading' | 'activating' | 'live' | 'failed';

interface Props {
  projectId: string;
  projectName: string;
  /** Has this project been published before? If false, show the first-publish warning. */
  isFirstPublish: boolean;
  onClose: () => void;
  /** Called when the publish completes successfully. */
  onPublished: (url: string) => void;
}

/**
 * Modal that drives one end-to-end publish. Starts immediately on mount and
 * walks through packaging → uploading → building → live, surfacing the
 * live URL with a "copy" button on success. Listens on the
 * `publish:progress:<projectId>` channel for phase updates from main.
 */
export function PublishModal({
  projectId,
  projectName,
  isFirstPublish,
  onClose,
  onPublished,
}: Props): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('packaging');
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const startedRef = useRef(false);

  // Subscribe + kick off the publish exactly once. (StrictMode in dev would
  // otherwise double-fire this — guarded with startedRef.)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unsubscribe = window.sprout.onPublishProgress(
      projectId,
      (event: PublishProgressEvent) => {
        switch (event.phase) {
          case 'building':
            setPhase('building'); break;
          case 'packaging':
            setPhase('packaging'); break;
          case 'uploading':
            setPhase('uploading');
            setBytesUploaded(event.bytes);
            break;
          case 'activating':
            setPhase('activating'); break;
          case 'live':
            setPhase('live');
            setUrl(event.url);
            break;
          case 'failed':
            setPhase('failed');
            setError(event.error);
            break;
        }
      },
    );

    void (async () => {
      try {
        const result = await window.sprout.invoke('projects:publish', { projectId });
        // The progress events will have already set phase + url, but cover the
        // race where the final 'live' progress message hasn't arrived yet.
        setPhase('live');
        setUrl(result.publishedUrl);
        onPublished(result.publishedUrl);
      } catch (err) {
        setPhase('failed');
        setError(humanError(err));
      }
    })();

    return unsubscribe;
  }, [projectId, onPublished]);

  return (
    <div className="modal-veil" onClick={phase === 'live' || phase === 'failed' ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">
            {phase === 'live' ? 'Live in sandbox' :
              phase === 'failed' ? 'Something went wrong' :
              'Sharing to sandbox…'}
          </div>
          <h2 className="modal-title">
            {phase === 'live' ? "It's live in the sandbox."
              : phase === 'failed' ? "Couldn't share to sandbox."
              : `Sending ${projectName} to the sandbox.`}
          </h2>
        </div>
        <div className="modal-body">
          {isFirstPublish && phase !== 'live' && phase !== 'failed' && (
            <div style={{
              padding: '10px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--line-soft)',
              borderRadius: 'var(--r-sm)',
              fontSize: 12.5,
              color: 'var(--ink-3)',
              lineHeight: 1.55,
            }}>
              First share can take a few minutes while we set up your app's home in the sandbox. Future shares will finish in under a minute.
            </div>
          )}

          {error && <div className="wizard-error">{error}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <PhaseRow label="Building your app" active={phase === 'building'} done={isAfter('building', phase)} />
            <PhaseRow label="Packaging files" active={phase === 'packaging'} done={isAfter('packaging', phase)} />
            <PhaseRow
              label={bytesUploaded > 0 ? `Uploading (${formatBytes(bytesUploaded)})` : 'Uploading'}
              active={phase === 'uploading'}
              done={isAfter('uploading', phase)}
            />
            <PhaseRow label="Going live" active={phase === 'activating'} done={phase === 'live'} />
          </div>

          {phase === 'live' && url && (
            <>
              <div className="url-preview" style={{
                background: 'var(--accent-soft)',
                borderColor: 'var(--accent)',
                borderStyle: 'solid',
              }}>
                <span style={{ color: 'var(--accent-ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {url}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-ink)' }}>
                  <span className="badge-dot" /> live
                </span>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={onClose}>Close</button>
                <button className="btn btn-primary" onClick={() => void copyText(url)}>Copy link</button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Sub ────────────────────────────────────────────────── */

function PhaseRow({ label, active, done }: { label: string; active: boolean; done: boolean }): React.ReactElement {
  return (
    <div className="action-step" style={{ padding: '8px 12px', border: '1px solid var(--line-soft)', borderRadius: 'var(--r-sm)' }}>
      <div className={`step-check ${done ? 'done' : active ? 'active' : 'pending'}`}>
        {done && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </div>
      <span>{label}</span>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

const PHASE_ORDER: Phase[] = ['idle', 'building', 'packaging', 'uploading', 'activating', 'live'];

function isAfter(target: Phase, current: Phase): boolean {
  // 'failed' is treated like a terminal state — no phases beyond it are done.
  if (current === 'failed') return false;
  return PHASE_ORDER.indexOf(current) > PHASE_ORDER.indexOf(target);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort — older clipboards may need a permission grant; for v1 we
    // just swallow the error since the URL is still visible in the modal.
  }
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}
