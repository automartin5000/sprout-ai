import React, { useEffect, useRef, useState } from 'react';
import type { DeployStatus, ProdDeployProgressEvent } from '../../main/ipc.js';

type Phase =
  | 'idle'
  | 'preflight'
  | 'scaffolding'
  | 'bootstrapping'
  | 'committing'
  | 'creating-repo'
  | 'pushing'
  | 'opening-pr'
  | 'done'
  | 'failed';

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
  /** Initial status snapshot (from `deploy:status` IPC). Used so the modal
   *  can render the picker / disabled state immediately without an extra
   *  loading flash. */
  initialStatus: DeployStatus;
}

/**
 * "Promote to prod" modal. Three states:
 *
 *   1. No provider installed → friendly error, link to setup docs.
 *   2. Multiple providers installed but none picked → one-time chooser.
 *   3. Provider active → progress through the phases, surface repo + PR URLs.
 *
 * Mirrors `PublishModal.tsx`'s visual structure so users learn the deploy
 * UX once. Subscribes to `prod-deploy:progress:<projectId>` for phase events.
 */
export function DeployProdModal({
  projectId,
  projectName,
  onClose,
  initialStatus,
}: Props): React.ReactElement {
  const [status, setStatus] = useState<DeployStatus>(initialStatus);
  const [phase, setPhase] = useState<Phase>('idle');
  const [repoUrl, setRepoUrl] = useState<string | undefined>(undefined);
  const [prUrl, setPrUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const startedRef = useRef(false);

  const canDeploy =
    status.resolution === 'active' &&
    // GitHub provider requires `gh`; other providers may not (Jenkins runs its
    // own remote-add inside the bootstrap script).
    (status.activeProvider !== 'sprout-cicd-github' || status.ghInstalled);

  // Kick off the deploy once we know we have an active provider with prereqs.
  useEffect(() => {
    if (!canDeploy || startedRef.current) return;
    startedRef.current = true;

    const unsubscribe = window.sprout.onProdDeployProgress(projectId, (event: ProdDeployProgressEvent) => {
      switch (event.phase) {
        case 'preflight':
        case 'scaffolding':
        case 'bootstrapping':
        case 'committing':
        case 'creating-repo':
        case 'pushing':
        case 'opening-pr':
          setPhase(event.phase);
          break;
        case 'done':
          setPhase('done');
          setRepoUrl(event.repoUrl);
          setPrUrl(event.prUrl);
          break;
        case 'failed':
          setPhase('failed');
          setError(event.error);
          break;
      }
    });

    void (async () => {
      try {
        const result = await window.sprout.invoke('projects:deployToProd', { projectId });
        setPhase('done');
        setRepoUrl(result.repoUrl);
        setPrUrl(result.prUrl);
      } catch (err) {
        setPhase('failed');
        setError(humanError(err));
      }
    })();

    return unsubscribe;
  }, [projectId, canDeploy]);

  async function handlePickProvider(pluginName: string): Promise<void> {
    const updated = await window.sprout.invoke('deploy:setProvider', { pluginName });
    setStatus(updated);
  }

  const dismissable = phase === 'idle' || phase === 'done' || phase === 'failed';

  return (
    <div className="modal-veil" onClick={dismissable ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">
            {phase === 'done' ? 'PR opened'
              : phase === 'failed' ? 'Something went wrong'
              : status.resolution === 'none' ? 'No deploy plugin'
              : status.resolution === 'choose' ? 'Pick a deploy provider'
              : 'Promoting to prod'}
          </div>
          <h2 className="modal-title">
            {phase === 'done' ? 'Review the PR.'
              : phase === 'failed' ? "Couldn't promote to prod."
              : status.resolution === 'none' ? "Sprout doesn't know how to promote to prod yet."
              : status.resolution === 'choose' ? 'Where should we promote to?'
              : `Promoting ${projectName} to prod.`}
          </h2>
        </div>
        <div className="modal-body">
          {status.resolution === 'none' && (
            <NoProviderHelp />
          )}

          {status.resolution === 'choose' && (
            <ProviderPicker candidates={status.candidates} onPick={(name) => void handlePickProvider(name)} />
          )}

          {status.resolution === 'active' && !canDeploy && status.activeProvider === 'sprout-cicd-github' && (
            <GhMissingHelp />
          )}

          {canDeploy && phase !== 'done' && phase !== 'failed' && (
            <FirstTimeNotice providerLabel={status.activeLabel ?? 'your CI/CD provider'} />
          )}

          {error && <div className="wizard-error">{error}</div>}

          {canDeploy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <PhaseRow label="Checking prerequisites" active={phase === 'preflight'} done={isAfter('preflight', phase)} />
              <PhaseRow label="Adding deploy files" active={phase === 'scaffolding'} done={isAfter('scaffolding', phase)} />
              <PhaseRow label="Installing dependencies" active={phase === 'bootstrapping'} done={isAfter('bootstrapping', phase)} />
              <PhaseRow label="Committing the changes" active={phase === 'committing'} done={isAfter('committing', phase)} />
              <PhaseRow label="Creating the GitHub repo" active={phase === 'creating-repo'} done={isAfter('creating-repo', phase)} />
              <PhaseRow label="Pushing to GitHub" active={phase === 'pushing'} done={isAfter('pushing', phase)} />
              <PhaseRow label="Opening a pull request" active={phase === 'opening-pr'} done={phase === 'done'} />
            </div>
          )}

          {phase === 'done' && repoUrl && prUrl && (
            <>
              <div className="url-preview" style={{
                background: 'var(--accent-soft)',
                borderColor: 'var(--accent)',
                borderStyle: 'solid',
                marginTop: 12,
              }}>
                <span style={{ color: 'var(--accent-ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {prUrl}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.55 }}>
                Review and merge the PR to finish the promotion. First deploy
                can take 10–15 minutes for AWS to propagate. Note: your
                sandbox data (DDB rows, uploads) does NOT migrate
                automatically — prod starts with empty stores.
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={onClose}>Close</button>
                <button className="btn btn-primary" onClick={() => void openExternal(prUrl)}>
                  Open PR
                </button>
              </div>
            </>
          )}

          {phase === 'failed' && (
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          )}

          {status.resolution === 'none' && (
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────── */

function NoProviderHelp(): React.ReactElement {
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line-soft)',
      borderRadius: 'var(--r-sm)', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55,
    }}>
      No deploy plugin is installed on this machine. On a personal install,
      Sprout ships <code>sprout-cicd-github</code> by default — if you're seeing
      this, something's wrong with the install. On a work install, ask your
      admin to drop the corp deploy plugin into{' '}
      <code>~/Library/Application Support/Electron/plugins/</code>.
    </div>
  );
}

function GhMissingHelp(): React.ReactElement {
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line-soft)',
      borderRadius: 'var(--r-sm)', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55,
    }}>
      <b>The GitHub CLI is not installed.</b><br />
      Sprout needs <code>gh</code> to create your project's repo. Install from{' '}
      <a href="https://cli.github.com" onClick={(e) => { e.preventDefault(); void openExternal('https://cli.github.com'); }}>
        cli.github.com
      </a>{' '}
      and then run <code>gh auth login</code>, then re-open this modal.
    </div>
  );
}

function ProviderPicker({
  candidates,
  onPick,
}: {
  candidates: Array<{ pluginName: string; label: string }>;
  onPick: (pluginName: string) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.55 }}>
        Multiple deploy plugins are installed. Pick one — your choice is saved
        and used for all future projects on this machine.
      </div>
      {candidates.map((c) => (
        <button
          key={c.pluginName}
          className="btn"
          style={{ justifyContent: 'flex-start', padding: '12px 14px' }}
          onClick={() => onPick(c.pluginName)}
        >
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-4)' }}>{c.pluginName}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function FirstTimeNotice({ providerLabel }: { providerLabel: string }): React.ReactElement {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line-soft)',
      borderRadius: 'var(--r-sm)', fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55,
    }}>
      We'll create a private repo, add deploy workflows for {providerLabel}, and
      open a PR for you to review. After you merge, the first deploy can take
      10–15 minutes for AWS to propagate.
    </div>
  );
}

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

/* ── Helpers ───────────────────────────────────────────────── */

const PHASE_ORDER: Phase[] = [
  'idle', 'preflight', 'scaffolding', 'bootstrapping', 'committing',
  'creating-repo', 'pushing', 'opening-pr', 'done',
];

function isAfter(target: Phase, current: Phase): boolean {
  if (current === 'failed') return false;
  return PHASE_ORDER.indexOf(current) > PHASE_ORDER.indexOf(target);
}

async function openExternal(url: string): Promise<void> {
  // The renderer can't directly use Electron's shell.openExternal; the
  // anchor's href is sandboxed. Falling back to window.open here works in dev
  // (Electron lets it punt to the system browser) — in production we'll wire
  // a `system:openExternal` IPC channel as a follow-up.
  window.open(url, '_blank');
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}
