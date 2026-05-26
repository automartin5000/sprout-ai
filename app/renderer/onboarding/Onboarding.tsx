import React, { useEffect, useState } from 'react';
import type { OnboardingStatus } from '../../main/ipc.js';
import type { Project } from '../../../shared/api-contract.js';
import { NewProjectModal } from './NewProjectModal.js';

type Stage = 'loading' | 'welcome' | 'pick-root' | 'list';

interface OnboardingProps {
  /** Called once the user has selected (or just created) a project. */
  onProjectOpen: (project: Project) => void;
}

/**
 * First-run + project-picker wizard. Routes between Welcome → RootPicker →
 * ProjectList based on persisted state. Once the user opens a project, calls
 * onProjectOpen and the parent App swaps to the main shell.
 */
export function Onboarding({ onProjectOpen }: OnboardingProps): React.ReactElement {
  const [status, setStatus] = useState<OnboardingStatus | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);
  const [stage, setStage] = useState<Stage>('loading');
  const [showNewProject, setShowNewProject] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await window.sprout.invoke('onboarding:status');
        if (cancelled) return;
        setStatus(s);
        // Re-show Welcome when auth state is invalid for this build mode.
        // The user can land here with setupComplete=true from a previous
        // MOCK_AUTH=1 session, then re-launch in real-auth mode without an
        // Auth0 token — at which point every cloud call would 401. Detect
        // that case (not signed in AND not explicitly guest) and force a
        // re-onboarding pass that includes the Sign In button.
        const needsAuth = !s.signedIn && !s.guest;
        if (!s.setupComplete || needsAuth) {
          setStage(s.guest || s.signedIn ? 'pick-root' : 'welcome');
        } else {
          const list = await window.sprout.invoke('projects:list');
          if (cancelled) return;
          setProjects(list);
          setStage('list');
          // Friendly auto-open if there are no projects yet
          if (list.length === 0) setShowNewProject(true);
        }
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function refreshStatus(): Promise<OnboardingStatus> {
    const s = await window.sprout.invoke('onboarding:status');
    setStatus(s);
    return s;
  }

  async function refreshProjects(): Promise<Project[]> {
    const list = await window.sprout.invoke('projects:list');
    setProjects(list);
    return list;
  }

  async function chooseSignIn(): Promise<void> {
    setError(undefined);
    try {
      await window.sprout.invoke('auth:login');
      await refreshStatus();
      setStage('pick-root');
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function chooseGuest(): Promise<void> {
    setError(undefined);
    try {
      await window.sprout.invoke('onboarding:setGuest', { guest: true });
      await refreshStatus();
      setStage('pick-root');
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function pickFolder(currentDefault: string): Promise<void> {
    setError(undefined);
    try {
      const picked = await window.sprout.invoke('onboarding:pickFolder', { defaultPath: currentDefault });
      if (!picked) return;
      const s = await window.sprout.invoke('onboarding:setProjectsRoot', { projectsRoot: picked });
      setStatus(s);
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function continueWithDefault(currentDefault: string): Promise<void> {
    setError(undefined);
    try {
      const s = await window.sprout.invoke('onboarding:setProjectsRoot', { projectsRoot: currentDefault });
      setStatus(s);
      const list = await refreshProjects();
      setStage('list');
      if (list.length === 0) setShowNewProject(true);
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function openProject(p: Project): Promise<void> {
    try {
      await window.sprout.invoke('projects:open', p.projectId);
      onProjectOpen(p);
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function deleteProject(p: Project): Promise<void> {
    setError(undefined);
    try {
      await window.sprout.invoke('projects:delete', { projectId: p.projectId });
      // Optimistically drop from the local list — server state already updated.
      setProjects((prev) => prev.filter((x) => x.projectId !== p.projectId));
    } catch (err) {
      setError(humanError(err));
    }
  }

  return (
    <div className="wizard">
      <WizardTop />
      <div className="wizard-body">
        {stage === 'loading' && <LoadingCard />}
        {stage === 'welcome' && (
          <WelcomeCard
            onSignIn={() => void chooseSignIn()}
            onGuest={() => void chooseGuest()}
            error={error}
          />
        )}
        {stage === 'pick-root' && status && (
          <RootPickerCard
            status={status}
            onPick={() => void pickFolder(status.projectsRoot)}
            onContinue={() => void continueWithDefault(status.projectsRoot)}
            error={error}
          />
        )}
        {stage === 'list' && status && (
          <ProjectListCard
            projects={projects}
            projectsRoot={status.projectsRoot}
            onNew={() => setShowNewProject(true)}
            onOpen={(p) => void openProject(p)}
            onDelete={(p) => void deleteProject(p)}
            error={error}
          />
        )}
      </div>

      {showNewProject && status && (
        <NewProjectModal
          projectsRoot={status.projectsRoot}
          guest={status.guest}
          onClose={() => setShowNewProject(false)}
          onCreated={(project) => {
            setShowNewProject(false);
            onProjectOpen(project);
          }}
        />
      )}
    </div>
  );
}

/* ── Cards ──────────────────────────────────────────────── */

function WizardTop(): React.ReactElement {
  return (
    <div className="wizard-top">
      <div className="brand">
        <div className="brand-mark">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
            <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
          </svg>
        </div>
        sprout
      </div>
    </div>
  );
}

function LoadingCard(): React.ReactElement {
  return (
    <div className="wizard-card">
      <div className="wizard-eyebrow">Just a moment</div>
      <h2 className="wizard-title">Getting things ready…</h2>
    </div>
  );
}

function WelcomeCard({
  onSignIn,
  onGuest,
  error,
}: {
  onSignIn: () => void;
  onGuest: () => void;
  error?: string;
}): React.ReactElement {
  return (
    <div className="wizard-card">
      <div className="wizard-eyebrow">Welcome</div>
      <h2 className="wizard-title">Build apps from ideas.</h2>
      <p className="wizard-sub">
        Sign in to sync your projects and share them online, or use the app as a guest to try things out locally.
      </p>
      {error && <div className="wizard-error">{error}</div>}
      <div className="wizard-actions">
        <button className="btn btn-accent" onClick={onSignIn}>Sign in</button>
        <button className="btn btn-ghost" onClick={onGuest}>Use as guest</button>
      </div>
    </div>
  );
}

function RootPickerCard({
  status,
  onPick,
  onContinue,
  error,
}: {
  status: OnboardingStatus;
  onPick: () => void;
  onContinue: () => void;
  error?: string;
}): React.ReactElement {
  return (
    <div className="wizard-card">
      <div className="wizard-eyebrow">Step 2 of 2</div>
      <h2 className="wizard-title">Where should we keep your projects?</h2>
      <p className="wizard-sub">
        Every project you create gets its own folder here. You can change this later in settings.
      </p>
      {error && <div className="wizard-error">{error}</div>}
      <div className="wizard-row">
        <label>Folder</label>
        <div className="path-picker">
          <input className="wizard-input" value={status.projectsRoot} readOnly />
          <button className="btn" onClick={onPick}>Choose…</button>
        </div>
      </div>
      <div className="wizard-actions">
        <button className="btn btn-accent" onClick={onContinue}>Continue</button>
      </div>
    </div>
  );
}

function ProjectListCard({
  projects,
  projectsRoot,
  onNew,
  onOpen,
  onDelete,
  error,
}: {
  projects: Project[];
  projectsRoot: string;
  onNew: () => void;
  onOpen: (p: Project) => void;
  onDelete: (p: Project) => void;
  error?: string;
}): React.ReactElement {
  const [confirming, setConfirming] = useState<Project | undefined>(undefined);
  const sorted = [...projects].sort((a, b) =>
    (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
  );
  return (
    <div className="wizard-card wide">
      <div className="wizard-eyebrow">Your projects</div>
      <h2 className="wizard-title">Pick a project, or start a new one.</h2>
      <p className="wizard-sub" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
        {projectsRoot}
      </p>
      {error && <div className="wizard-error">{error}</div>}

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No projects yet</p>
          <p className="empty-state-sub">Create your first one — it takes about a minute.</p>
        </div>
      ) : (
        <div className="project-list">
          {sorted.map((p) => (
            // Outer is a div (not a button) because we nest a delete button inside.
            // role="button" + onKeyDown gives back the keyboard semantics.
            <div
              key={p.projectId}
              className="project-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(p)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); } }}
            >
              <div className="project-card-icon">{p.name.charAt(0).toUpperCase()}</div>
              <div className="project-card-meta">
                <div className="project-card-name">{p.name}</div>
                <div className="project-card-sub">{relativeTime(p.lastOpenedAt ?? p.createdAt)}</div>
              </div>
              <button
                type="button"
                className="project-card-delete"
                aria-label={`Delete ${p.name}`}
                title="Delete project"
                onClick={(e) => { e.stopPropagation(); setConfirming(p); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
              <div className="project-card-chevron">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <DeleteConfirm
          project={confirming}
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => { onDelete(confirming); setConfirming(undefined); }}
        />
      )}

      <div className="wizard-actions">
        <button className="btn btn-accent" onClick={onNew}>+ New project</button>
      </div>
    </div>
  );
}

function DeleteConfirm({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  return (
    <div className="modal-veil" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <div className="modal-eyebrow">Delete project</div>
          <h2 className="modal-title">Delete {project.name}?</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--ink-3)', fontSize: 13.5, margin: 0, lineHeight: 1.5 }}>
            This removes the project folder and all its files from your machine. Anything you've already published online stays up — close the public URL separately if you want it gone too.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip Electron's "Error invoking remote method '…':" prefix
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}

function relativeTime(iso?: string): string {
  if (!iso) return 'just now';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
