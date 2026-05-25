import React from 'react';

/**
 * The actual rendered preview is a native WebContentsView positioned over this
 * pane by the main process (see `layoutPreview` in app/main/index.ts). This
 * component renders the slim URL pill on top + an empty stage div below.
 * The WebContentsView floats over the stage.
 *
 * Code / Mobile tabs, save-points timeline, and the git-branch indicator
 * are intentionally omitted — they were Phase-1 chrome with no real
 * implementation behind them. We'll bring them back when there's working
 * code to attach.
 */
export function PreviewPane({ previewUrl }: { previewUrl?: string } = {}): React.ReactElement {
  const display = formatUrlForPill(previewUrl);

  return (
    <section className="preview-col">
      <div className="preview-bar">
        <div className="url-pill" style={{ flex: 1 }}>
          <LockIcon />
          <span style={{ color: 'var(--ink-4)' }}>{display.host}</span>
          <span className="path">{display.path}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="badge-dot" />
            <span style={{ color: 'var(--ink-4)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              {previewUrl ? 'live' : 'starting…'}
            </span>
          </span>
        </div>
      </div>

      {/* Stage — native WebContentsView overlays here */}
      <div className="preview-stage">
        <div className="preview-placeholder">
          {previewUrl ? 'Loading…' : 'Your preview will appear here once Sprout starts running your app.'}
        </div>
      </div>
    </section>
  );
}

function LockIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

/** Splits a URL into the "host:" / "path" parts the URL pill expects. */
function formatUrlForPill(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: '—', path: '' };
  try {
    const u = new URL(url);
    // Display "your app · :5173" — friendlier than "localhost:5173".
    return {
      host: 'your app',
      path: u.port ? `:${u.port}` : '',
    };
  } catch {
    return { host: url, path: '' };
  }
}
