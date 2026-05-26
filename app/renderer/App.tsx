import React, { useEffect, useState } from 'react';
import type { Project } from '../../shared/api-contract.js';
import type { DeployStatus } from '../main/ipc.js';
import { ChatPane } from './chat/ChatPane.js';
import { PreviewPane } from './preview/PreviewPane.js';
import { Onboarding } from './onboarding/Onboarding.js';
import { PublishModal } from './publish/PublishModal.js';
import { ShareModal } from './share/ShareModal.js';
import { DeployProdModal } from './deploy/DeployProdModal.js';

export function App(): React.ReactElement {
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [available, setAvailable] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [bootChecked, setBootChecked] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showDeployProd, setShowDeployProd] = useState(false);
  const [guest, setGuest] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [hasEverPublished, setHasEverPublished] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | undefined>(undefined);

  // Boot: load AI list + onboarding state. We intentionally do NOT auto-open
  // the most-recently-used project — the user asked for the project list to
  // be the home screen on every launch. Auto-open also landed on an empty
  // chat (no history persistence yet) which looked broken.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, status, deployS] = await Promise.all([
          window.sprout.invoke('harness:info'),
          window.sprout.invoke('onboarding:status'),
          window.sprout.invoke('deploy:status'),
        ]);
        if (cancelled) return;
        setAvailable(info.available);
        setGuest(status.guest);
        setSignedIn(status.signedIn);
        setDeployStatus(deployS);
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

  // Native preview view sits ABOVE renderer HTML regardless of CSS z-index.
  // Whenever any modal is open we have to hide it, or the modal renders
  // behind the geoguesser/whatever preview and looks like a no-op click.
  // This effect tracks the union of all modal-open flags and toggles the
  // preview accordingly.
  useEffect(() => {
    const anyModalOpen = showPublish || showShare || showDeployProd;
    // Only meaningful when a preview is attached — if previewUrl is undefined
    // there's no native view to hide.
    if (!previewUrl) return;
    void window.sprout.invoke('preview:setVisible', { visible: !anyModalOpen });
  }, [showPublish, showShare, showDeployProd, previewUrl]);

  // ⌘[ keyboard shortcut for back-to-projects. Phase 6 removed the visible
  // crumb in favor of a single left-edge icon button + the centered title;
  // the keyboard shortcut keeps the navigation discoverable for users who
  // know the standard macOS "back" chord. Only active when a project is
  // open (matches the icon button's visibility) and no modal is up
  // (so cmd-[ doesn't fight in-modal focus traps).
  useEffect(() => {
    if (!project) return;
    const anyModalOpen = showPublish || showShare || showDeployProd;
    if (anyModalOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        void window.sprout.invoke('projects:close', project.projectId);
        setProject(undefined);
        setPreviewUrl(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, showPublish, showShare, showDeployProd]);

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
        signedIn={signedIn}
        deployStatus={deployStatus}
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
        onSharePreview={() => setShowPublish(true)}
        onPublishToProd={() => setShowDeployProd(true)}
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
      {showDeployProd && deployStatus && (
        <DeployProdModal
          projectId={project.projectId}
          projectName={project.name}
          initialStatus={deployStatus}
          onClose={() => {
            setShowDeployProd(false);
            // Refresh status — the user may have just picked a provider in
            // the chooser, and the next click should skip straight to deploy.
            void window.sprout.invoke('deploy:status').then(setDeployStatus);
          }}
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
      <PreviewPane projectId={project.projectId} previewUrl={previewUrl} projectName={project.name} />
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
  signedIn,
  deployStatus,
  onSwitchAi,
  onBackToProjects,
  onShare,
  onSharePreview,
  onPublishToProd,
}: {
  project: Project;
  available: string[];
  error?: string;
  previewLive: boolean;
  guest: boolean;
  signedIn: boolean;
  deployStatus?: DeployStatus;
  onSwitchAi: (id: string) => void;
  onBackToProjects: () => void;
  onShare: () => void;
  onSharePreview: () => void;
  onPublishToProd: () => void;
}): React.ReactElement {
  // Cloud-side buttons (Share preview to sandbox / Invite / Promote to prod) all need a
  // real JWT to hit the deployed API. `guest` covers the explicit "Use as
  // guest" path; `!signedIn` catches the case where the user previously ran
  // in MOCK_AUTH=1, set setupComplete=true, and re-launched in real-auth
  // mode without re-onboarding. Either condition → disable + tooltip.
  const cloudDisabled = guest || !signedIn;
  const cloudDisabledReason = guest
    ? 'Sign in to use cloud features'
    : !signedIn ? 'Sign in first (click "Projects" → Sign in)' : undefined;

  // "Promote to prod" requires a CI/CD provider AND (if GitHub) the `gh` CLI.
  // Still show the button when a provider exists but a prereq is missing —
  // the modal explains what's wrong. Only hide when there's no provider at all.
  const showProdButton = deployStatus && deployStatus.resolution !== 'none';
  const prodDisabledReason =
    cloudDisabledReason
      ?? (!deployStatus ? undefined
        : deployStatus.resolution === 'choose' ? 'Pick a deploy provider first'
        : deployStatus.activeProvider === 'sprout-cicd-github' && !deployStatus.ghInstalled
          ? 'GitHub CLI (gh) is not installed'
          : undefined);
  return (
    <header className="topbar">
      {/* Left-edge back-to-projects button. Sits after the macOS
       * traffic-lights gutter (~68px). Replaces the explicit
       * "← Projects / <name>" crumb that used to live here. Full text
       * label rather than icon-only — the icon was too cryptic in
       * isolation. ⌘[ keyboard shortcut also wired. */}
      <button
        className="btn btn-sm topbar-back"
        onClick={onBackToProjects}
        title="Back to your projects (⌘[)"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back to projects
      </button>

      {/* Centered app title — absolute-positioned, pointer-events: none.
       * "Sprout — <projectName>" reads as a native macOS window title.
       * Live badge sits inline after the project name when preview is up. */}
      <div className="app-title">
        <b>Sprout</b>
        <span className="sep">—</span>
        <span className="sub">{project.name}</span>
        {previewLive && <span className="live-dot" title="Preview is running" />}
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
          className="btn btn-sm btn-accent-blue"
          onClick={onSharePreview}
          title={cloudDisabledReason ?? 'Send a quick preview link teammates can open immediately'}
          disabled={cloudDisabled}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
            <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
          </svg>
          Share preview to sandbox
        </button>
      )}
      {previewLive && showProdButton && (
        <button
          className="btn btn-sm btn-accent"
          onClick={onPublishToProd}
          title={prodDisabledReason ?? 'Push to your own GitHub repo and deploy to AWS via CI/CD'}
          disabled={!!cloudDisabledReason}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12V7a2 2 0 0 1 2-2h3"/>
            <path d="M19 12V7a2 2 0 0 0-2-2h-3"/>
            <path d="M5 12v5a2 2 0 0 0 2 2h3"/>
            <path d="M19 12v5a2 2 0 0 1-2 2h-3"/>
            <circle cx="12" cy="12" r="2"/>
          </svg>
          Promote to prod
        </button>
      )}
      <button
        className="btn btn-sm"
        onClick={onShare}
        title={cloudDisabledReason ?? 'Invite a teammate to edit this project alongside you'}
        disabled={cloudDisabled}
      >
        {/* user-plus icon — clearer than the upload arrow which read as
            "share/export" and overlapped with "Share preview to sandbox" semantically. */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="8.5" cy="7" r="4"/>
          <line x1="20" y1="8" x2="20" y2="14"/>
          <line x1="23" y1="11" x2="17" y2="11"/>
        </svg>
        Invite
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
