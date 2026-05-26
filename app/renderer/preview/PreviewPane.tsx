import React from 'react';

type Device = 'desktop' | 'phone';
interface Checkpoint {
  hash: string;
  subject: string;
  ts: string;
}

/**
 * The actual rendered preview is a native WebContentsView positioned over this
 * pane by the main process (see `layoutPreview` in app/main/index.ts). This
 * component renders the mac-native preview bar on top + an empty stage div
 * below + the save-points timeline at the bottom. The WebContentsView floats
 * over the stage.
 *
 * Desktop / Phone segmented tabs: switching to Phone sends an IPC to the
 * main process which shrinks the WebContentsView to PHONE_WIDTH and
 * centers it inside the column. The CSS also adds a subtle phone-frame
 * border around the stage.
 */
export function PreviewPane({
  projectId,
  previewUrl,
  projectName,
}: { projectId?: string; previewUrl?: string; projectName?: string } = {}): React.ReactElement {
  const live = !!previewUrl;
  const [device, setDevice] = React.useState<Device>('desktop');
  const [checkpoints, setCheckpoints] = React.useState<Checkpoint[]>([]);
  const [activeHash, setActiveHash] = React.useState<string | undefined>(undefined);

  // Tell main about the device every time it changes so the native
  // WebContentsView gets resized to match. Also fire once on mount so the
  // layout is consistent if a previous session left a non-default value.
  React.useEffect(() => {
    void window.sprout.invoke('preview:setDevice', { device });
  }, [device]);

  // Load the project's recent save points. Refresh every few seconds while
  // the project is open — checkpoints land at the tail of every harness
  // turn, and a periodic refresh is the simplest way to keep the strip in
  // sync without subscribing to a stream. 4s feels live enough.
  const reloadCheckpoints = React.useCallback(async (): Promise<void> => {
    if (!projectId) return;
    try {
      const cps = await window.sprout.invoke('projects:checkpoints', { projectId, limit: 12 });
      // Newest first from git; we display newest on the right (mac
      // timeline convention), so reverse here. The active save point is
      // ALWAYS the newest after a refresh — restore writes a "rolled
      // back to" commit at HEAD, so HEAD is what the timeline should
      // highlight. (Clicking an older card just kicks off a restore;
      // the refresh that follows will move "active" to the new HEAD.)
      setCheckpoints(cps.slice().reverse());
      if (cps[0]) setActiveHash(cps[0].hash);
    } catch {
      // Worktree may not exist on a brand-new project — fail silent;
      // the strip just stays empty.
    }
  }, [projectId]);

  React.useEffect(() => {
    if (!projectId) return;
    void reloadCheckpoints();
    const id = setInterval(reloadCheckpoints, 4000);
    return () => clearInterval(id);
  }, [projectId, reloadCheckpoints]);

  const onJumpCheckpoint = async (cp: Checkpoint): Promise<void> => {
    if (!projectId || cp.hash === activeHash) return;
    try {
      await window.sprout.invoke('projects:restoreCheckpoint', { projectId, hash: cp.hash });
      // Refresh immediately so the new "rolled back to" save point
      // appears at HEAD instead of waiting up to 4s for the next poll.
      await reloadCheckpoints();
    } catch {
      // Restore failed — refresh anyway so the optimistic state resyncs.
      await reloadCheckpoints();
    }
  };

  return (
    <section className="preview-col">
      <div className="preview-bar">
        {/* Mac segmented control. Switches between Desktop (full-column)
         * and Phone (centered, PHONE_WIDTH-wide) preview. */}
        <div className="view-tabs" role="tablist">
          <button
            className="view-tab"
            data-active={device === 'desktop'}
            onClick={() => setDevice('desktop')}
            title="Desktop preview (full width)"
          >
            <DesktopIcon /> Desktop
          </button>
          <button
            className="view-tab"
            data-active={device === 'phone'}
            onClick={() => setDevice('phone')}
            title="Phone preview (390px wide)"
          >
            <PhoneIcon /> Phone
          </button>
        </div>

        <div className="status-pill" title="Your app is running. Every change saves automatically.">
          <span className="dot" style={live ? undefined : { background: 'var(--ink-4)', boxShadow: 'none' }} />
          <span className="title">{projectName ?? 'your app'}</span>
          <span className="meta">· {live ? 'live · auto-saved' : 'starting…'}</span>
        </div>

        <div className="preview-bar-actions">
          {/* History button — visual entry point for the future
           * "rewind to a save point" feature. The bottom timeline is the
           * primary affordance; this button opens a fuller history modal
           * (also a follow-up). */}
          <button
            className="btn btn-sm"
            title="Browse all save points (coming soon)"
            disabled
          >
            <HistoryIcon />
            History
          </button>
        </div>
      </div>

      {/* Stage — native WebContentsView overlays here. The phone-frame
       * class adds a subtle border + rounded corners to suggest the
       * device frame; the WebContentsView itself fills the inner area. */}
      <div className={`preview-stage${device === 'phone' ? ' is-phone' : ''}`}>
        <div className="preview-placeholder">
          {previewUrl ? 'Loading…' : 'Your preview will appear here once Sprout starts running your app.'}
        </div>
      </div>

      {/* Save points timeline — horizontal strip of recent checkpoints.
       * Clicking a card restores the worktree to that point via
       * `projects:restoreCheckpoint`. The active card gets a terracotta
       * outline. */}
      <div className="timeline">
        <div className="timeline-label">
          <HistoryIcon /> Save points
        </div>
        <div className="timeline-track">
          {checkpoints.length === 0 && (
            <div className="timeline-empty">
              Your save points will appear here as you make changes.
            </div>
          )}
          {checkpoints.map((cp, i) => (
            <button
              key={cp.hash}
              className="checkpoint"
              data-active={cp.hash === activeHash}
              onClick={() => void onJumpCheckpoint(cp)}
              title={
                cp.hash === activeHash
                  ? `Current save point: ${cp.subject || '(no description)'}\nSaved ${relativeTime(cp.ts)} ago · ${cp.hash.slice(0, 7)}`
                  : `Roll back to: ${cp.subject || '(no description)'}\nSaved ${relativeTime(cp.ts)} ago · ${cp.hash.slice(0, 7)}\n\nYour current work will be snapshotted first — nothing is lost.`
              }
            >
              <CheckpointSnap index={i} total={checkpoints.length} />
              <div className="checkpoint-label">{cp.subject || 'save point'}</div>
              <div className="checkpoint-time">{relativeTime(cp.ts)}</div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Mini SVG snapshot per checkpoint. We don't have a real screenshot
 * pipeline yet, so the snap is a deterministic procedural shape based on
 * the checkpoint's position in the timeline — gives the strip visual
 * variety without faking content. Older snaps are simpler (fewer
 * elements); newer ones have a richer layout, evoking a project growing.
 */
function CheckpointSnap({ index, total }: { index: number; total: number }): React.ReactElement {
  const stage = total <= 1
    ? 'empty'
    : index < total * 0.25 ? 'empty'
    : index < total * 0.5  ? 'list'
    : index < total * 0.75 ? 'streaks'
    :                        'full';
  return (
    <div className="checkpoint-snap">
      <svg viewBox="0 0 80 32" width="100%" height="100%" preserveAspectRatio="none">
        <rect width="80" height="32" fill="#fdfbf6" />
        <rect width="14" height="32" fill="#f0e8d4" />
        {stage !== 'empty' && (<>
          <rect x="18" y="3" width="20" height="3" rx="1" fill="#1a1814" />
          <rect x="18" y="8" width="32" height="2" rx="1" fill="#c8a87a" />
        </>)}
        {(stage === 'streaks' || stage === 'full') && (<>
          <rect x="18" y="13" width="9" height="5" rx="1.5" fill="#fff" stroke="#e8dfca" strokeWidth=".5" />
          <rect x="29" y="13" width="9" height="5" rx="1.5" fill="#fff" stroke="#e8dfca" strokeWidth=".5" />
          <rect x="40" y="13" width="9" height="5" rx="1.5" fill="#fff" stroke="#e8dfca" strokeWidth=".5" />
        </>)}
        {(stage === 'list' || stage === 'streaks' || stage === 'full') && (<>
          <rect x="18" y={stage === 'list' ? 13 : 21} width="56" height="3" rx="1" fill="#fff" stroke="#e8dfca" strokeWidth=".5" />
          <circle cx="20" cy={stage === 'list' ? 14.5 : 22.5} r="1" fill="#6e9355" />
          <rect x="18" y={stage === 'list' ? 17 : 25} width="56" height="3" rx="1" fill="#fff" stroke="#e8dfca" strokeWidth=".5" />
          <circle cx="20" cy={stage === 'list' ? 18.5 : 26.5} r="1" fill="#6e9355" />
        </>)}
        {stage === 'full' && (<>
          {[0,1,2,3,4,5,6].map((i) => (
            <rect key={i} x={18 + i * 8} y="28" width="6" height="3" rx="1"
                  fill={['#6e9355','#a8c585','#6e9355','#d6e3c1','#6e9355','#a8c585','#f0e8d4'][i]} />
          ))}
        </>)}
      </svg>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 30) return 'just now';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function DesktopIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
}

function PhoneIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <line x1="12" y1="18" x2="12.01" y2="18"/>
    </svg>
  );
}

function HistoryIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3.5-7.1L3 8"/>
      <polyline points="3 3 3 8 8 8"/>
      <polyline points="12 7 12 12 15 14"/>
    </svg>
  );
}
