import React, { useEffect, useState } from 'react';
import type { Project } from '../../shared/api-contract.js';
import { ChatPane } from './chat/ChatPane.js';
import { PreviewPane } from './preview/PreviewPane.js';
import { Onboarding } from './onboarding/Onboarding.js';
import { PublishModal } from './publish/PublishModal.js';
import { ShareModal } from './share/ShareModal.js';

export function App(): React.ReactElement {
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [available, setAvailable] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [bootChecked, setBootChecked] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [guest, setGuest] = useState(false);
  const [hasEverPublished, setHasEverPublished] = useState(false);

  // Boot: load AI list + onboarding state. We intentionally do NOT auto-open
  // the most-recently-used project — the user asked for the project list to
  // be the home screen on every launch. Auto-open also landed on an empty
  // chat (no history persistence yet) which looked broken.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, status] = await Promise.all([
          window.sprout.invoke('harness:info'),
          window.sprout.invoke('onboarding:status'),
        ]);
        if (cancelled) return;
        setAvailable(info.available);
        setGuest(status.guest);
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      } finally {
        if (!cancelled) setBootChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Listen for preview-URL handoffs from the main process
  useEffect(() => {
    const unsub = window.sprout.onPreviewUrl((url) => setPreviewUrl(url));
    return unsub;
  }, []);

  async function switchAi(harnessId: string): Promise<void> {
    if (!project) return;
    try {
      const updated = await window.sprout.invoke('projects:setHarness', {
        projectId: project.projectId,
        harnessId,
      });
      setProject(updated);
    } catch (err) {
      setError(humanError(err));
    }
  }

  function handleProjectOpen(p: Project): void {
    // The Onboarding wizard already called `projects:open` before invoking
    // this callback — don't duplicate it here, or we'll spawn two dev
    // servers in parallel. Just flip the visible state.
    setProject(p);
  }

  // While booting, render nothing — keeps the welcome card from flashing
  if (!bootChecked) {
    return <div className="wizard"><div className="wizard-top" /></div>;
  }

  // No project open → show onboarding wizard (handles welcome / pick-root / list)
  if (!project) {
    return <Onboarding onProjectOpen={handleProjectOpen} />;
  }

  // Project is open → adaptive shell
  return (
    <div className="shell">
      <TopBar
        project={project}
        available={available}
        error={error}
        previewLive={!!previewUrl}
        guest={guest}
        onSwitchAi={switchAi}
        onBackToProjects={() => {
          // Tell main to stop the dev server + tear down the WebContentsView
          // BEFORE clearing local state, so the preview disappears in sync
          // with the UI swap rather than hanging on top of the project list.
          if (project) void window.sprout.invoke('projects:close', project.projectId);
          setProject(undefined);
          setPreviewUrl(undefined);
        }}
        onShare={() => setShowShare(true)}
        onPublish={() => setShowPublish(true)}
      />
      {previewUrl ? (
        <SplitLayout project={project} previewUrl={previewUrl} />
      ) : (
        <ChatOnlyLayout project={project} />
      )}

      {showPublish && (
        <PublishModal
          projectId={project.projectId}
          projectName={project.name}
          isFirstPublish={!hasEverPublished}
          onClose={() => setShowPublish(false)}
          onPublished={() => setHasEverPublished(true)}
        />
      )}
      {showShare && (
        <ShareModal
          projectId={project.projectId}
          projectName={project.name}
          guest={guest}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

/* ── Layouts ────────────────────────────────────────────── */

function ChatOnlyLayout({ project }: { project: Project }): React.ReactElement {
  return (
    <div style={{
      display: 'grid',
      placeItems: 'start center',
      minHeight: 0,
      background: 'var(--bg-soft)',
      padding: '24px 16px 0',
      overflow: 'hidden',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 720,
        height: '100%',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-xl) var(--r-xl) 0 0',
        boxShadow: '0 12px 40px -16px rgba(0,0,0,.08)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}>
        <ChatPane project={project} />
      </div>
    </div>
  );
}

function SplitLayout({
  project,
  previewUrl,
}: {
  project: Project;
  previewUrl: string;
}): React.ReactElement {
  // Two columns matching `.main { grid-template-columns: 380px 1fr }` in
  // sprout.css: chat on the left, preview on the right. The native
  // WebContentsView is positioned over the right column by the main process
  // (see layoutPreview in app/main/index.ts) — those layout constants must
  // stay in sync with the CSS grid.
  return (
    <div className="main">
      <ChatPane project={project} />
      <PreviewPane previewUrl={previewUrl} />
    </div>
  );
}

/* ── Top bar (single source of truth) ─────────────────── */

function TopBar({
  project,
  available,
  error,
  previewLive,
  guest,
  onSwitchAi,
  onBackToProjects,
  onShare,
  onPublish,
}: {
  project: Project;
  available: string[];
  error?: string;
  previewLive: boolean;
  guest: boolean;
  onSwitchAi: (id: string) => void;
  onBackToProjects: () => void;
  onShare: () => void;
  onPublish: () => void;
}): React.ReactElement {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
            <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
          </svg>
        </div>
        sprout
      </div>

      <div className="crumb">
        <button
          className="btn btn-sm"
          onClick={onBackToProjects}
          title="Back to your projects"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', color: 'var(--ink-2)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Projects
        </button>
        <span className="crumb-sep">/</span>
        <b>{project.name}</b>
        {previewLive && (
          <span style={{
            marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, color: 'var(--ok)', fontFamily: 'var(--font-mono)',
          }}>
            <span className="badge-dot" />
            live
          </span>
        )}
      </div>

      <div className="topbar-spacer" />

      {error && (
        <span style={{
          fontSize: 11, color: 'var(--err)', maxWidth: 260,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {error}
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>AI:</span>
        {available.length > 1 ? (
          <select
            className="harness-select"
            value={project.harnessId}
            onChange={(e) => void onSwitchAi(e.target.value)}
          >
            {available.map((id) => (
              <option key={id} value={id}>{friendlyAi(id)}</option>
            ))}
          </select>
        ) : (
          <span style={{
            fontSize: 12, fontFamily: 'var(--font-mono)',
            color: 'var(--ink-2)', padding: '1px 8px',
            border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
            background: 'var(--surface)',
          }}>
            {friendlyAi(project.harnessId)}
          </span>
        )}
      </div>

      <div className="divider-v" />

      {previewLive && (
        <button
          className="btn btn-sm btn-accent"
          onClick={onPublish}
          title={guest ? 'Sign in to publish' : 'Publish the current version of this app to the cloud'}
          disabled={guest}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
            <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
          </svg>
          Publish
        </button>
      )}
      <button
        className="btn btn-sm"
        onClick={onShare}
        title={guest ? 'Sign in to share' : 'Share this project with a teammate'}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
          <polyline points="16 6 12 2 8 6"/>
          <line x1="12" y1="2" x2="12" y2="15"/>
        </svg>
        Share
      </button>

      <div className="avatar">M</div>
    </header>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

function friendlyAi(id: string): string {
  const map: Record<string, string> = {
    copilot: 'Copilot',
    claude: 'Claude',
    openai: 'OpenAI',
    mock: 'Demo',
  };
  return map[id] ?? id;
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}
