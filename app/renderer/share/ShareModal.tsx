import React, { useEffect, useState } from 'react';

interface Props {
  projectId: string;
  projectName: string;
  /** True if the user is in guest mode — Share is disabled. */
  guest: boolean;
  onClose: () => void;
}

/**
 * Generates a short project code that teammates can paste into their own
 * sprout's "Have a project code?" field to clone+collaborate. The
 * underlying API mints a SHARE# row with grants='edit' so collaborators can
 * also Publish to the same URL.
 */
export function ShareModal({ projectId, projectName, guest, onClose }: Props): React.ReactElement {
  const [code, setCode] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Auto-mint the code on open unless guest
  useEffect(() => {
    if (guest) return;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const res = await window.sprout.invoke('projects:share', {
          projectId,
          grants: 'edit',
        });
        if (!cancelled) setCode(res.code);
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, guest]);

  async function handleCopy(): Promise<void> {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — code is still visible
    }
  }

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">Share</div>
          <h2 className="modal-title">Invite someone to {projectName}.</h2>
        </div>
        <div className="modal-body">
          {guest ? (
            <>
              <p style={{ color: 'var(--ink-3)', fontSize: 13.5, margin: 0 }}>
                Sharing needs a signed-in account so we can route collaborators back to your project. Sign in from the welcome screen, then come back.
              </p>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={onClose}>Got it</button>
              </div>
            </>
          ) : error ? (
            <>
              <div className="wizard-error">{error}</div>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={onClose}>Close</button>
              </div>
            </>
          ) : (
            <>
              <p style={{ color: 'var(--ink-3)', fontSize: 13.5, margin: 0 }}>
                Send this code to a teammate. They paste it into their app and can edit the project alongside you. Anything either of you publishes goes to the same live URL.
              </p>

              <div className="wizard-row">
                <label>Project code</label>
                <div className="path-picker">
                  <input
                    className="wizard-input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 18, letterSpacing: 4, textAlign: 'center' }}
                    value={busy ? '…' : code ?? ''}
                    readOnly
                  />
                  <button className="btn btn-accent" onClick={() => void handleCopy()} disabled={!code}>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="wizard-input-hint">
                  Codes don't expire by default. You can revoke them from settings later.
                </div>
              </div>

              <div className="modal-actions">
                <button className="btn" onClick={onClose}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}
