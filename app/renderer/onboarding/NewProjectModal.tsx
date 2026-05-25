import React, { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../shared/api-contract.js';

interface Props {
  projectsRoot: string;
  /** True if the user is in guest mode — disables the join-by-code field. */
  guest: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

interface Starter {
  id: string;
  name: string;
  description: string;
  pluginName: string;
}

const FRIENDLY_AI: Record<string, string> = {
  copilot: 'Copilot',
  claude: 'Claude',
  openai: 'OpenAI',
  mock: 'Demo (no-op)',
};

/**
 * Modal shown when the user clicks "+ New project" (or auto-opens on an empty
 * project list). Asks for a name, AI, starter, plus an optional project-code
 * field for joining an existing shared project.
 */
export function NewProjectModal({
  projectsRoot,
  guest,
  onClose,
  onCreated,
}: Props): React.ReactElement {
  const [name, setName] = useState('');
  const [ais, setAis] = useState<{ available: string[]; defaultId: string } | undefined>(undefined);
  const [ai, setAi] = useState<string>('');
  const [starters, setStarters] = useState<Starter[]>([]);
  const [starter, setStarter] = useState<string>('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Load AIs + starters in parallel
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [info, starterList] = await Promise.all([
          window.sprout.invoke('harness:info'),
          window.sprout.invoke('plugins:starters'),
        ]);
        if (cancelled) return;
        // Default to whatever the registry suggests is actually usable on
        // this machine (Claude if ANTHROPIC_API_KEY or ~/.claude exists,
        // Copilot only when the SDK is bundled, mock otherwise). The
        // per-project harnessId is independent of this default — if the
        // user picks something else for a given project, that choice
        // persists in the project's state.json on disk.
        setAis({ available: info.available, defaultId: info.defaultAdapterId });
        setAi(info.defaultAdapterId);
        setStarters(starterList);
        // Default starter preference: first-party sprout:new-app (no AWS
        // account onboarding), then vibe-aws:new-app (advanced/self-host),
        // then whichever else is around, then empty.
        const sproutNewApp = starterList.find((s) => s.id === 'sprout:new-app');
        const vibeNewApp = starterList.find((s) => s.id === 'vibe-aws:new-app');
        setStarter(sproutNewApp?.id ?? vibeNewApp?.id ?? starterList[0]?.id ?? '');
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const slug = useMemo(() => slugify(name), [name]);
  const previewPath = useMemo(
    () => (slug ? `${projectsRoot}/${slug}` : `${projectsRoot}/…`),
    [projectsRoot, slug],
  );

  async function handleCreate(): Promise<void> {
    if (!name.trim() || !ai || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const project = await window.sprout.invoke('projects:create', {
        name: name.trim(),
        slug,
        harnessId: ai,
      });
      onCreated(project);
    } catch (err) {
      setError(humanError(err));
      setBusy(false);
    }
  }

  async function handleJoin(): Promise<void> {
    if (!joinCode.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // Server-side join endpoint will land with the cloud-publish work.
      // For now, surface a friendly explanation rather than a 404.
      setError("Joining by code will be available once you've signed in and the cloud features are turned on.");
      setBusy(false);
    } catch (err) {
      setError(humanError(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">New project</div>
          <h2 className="modal-title">Start something fresh.</h2>
        </div>
        <div className="modal-body">
          {error && <div className="wizard-error">{error}</div>}

          <div className="wizard-row">
            <label>Project name</label>
            <input
              className="wizard-input"
              autoFocus
              value={name}
              placeholder="e.g. Habit Tracker"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
            <div className="wizard-input-hint">{previewPath}</div>
          </div>

          <div className="wizard-row">
            <label>AI</label>
            <select
              className="wizard-input"
              value={ai}
              onChange={(e) => setAi(e.target.value)}
              disabled={!ais}
            >
              {ais?.available.map((id) => (
                <option key={id} value={id}>{FRIENDLY_AI[id] ?? id}</option>
              ))}
              {!ais && <option value="">Loading…</option>}
            </select>
          </div>

          <div className="wizard-row">
            <label>Starter</label>
            <select
              className="wizard-input"
              value={starter}
              onChange={(e) => setStarter(e.target.value)}
            >
              {starters.length === 0 ? (
                <option value="">Empty (start from scratch)</option>
              ) : (
                <>
                  <option value="">Empty (start from scratch)</option>
                  {starters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {friendlyStarterLabel(s)}
                    </option>
                  ))}
                </>
              )}
            </select>
            {starter && (
              <div className="wizard-input-hint">
                {starters.find((s) => s.id === starter)?.description ?? ''}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn btn-accent"
              onClick={() => void handleCreate()}
              disabled={!name.trim() || !ai || busy}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>

          <div className="wizard-divider">or</div>

          <div className="wizard-row">
            <label>Have a project code?</label>
            <div className="path-picker">
              <input
                className="wizard-input"
                value={joinCode}
                placeholder="paste a code from a teammate"
                onChange={(e) => setJoinCode(e.target.value)}
                disabled={guest || busy}
              />
              <button className="btn" onClick={() => void handleJoin()} disabled={!joinCode.trim() || guest || busy}>
                Open
              </button>
            </div>
            {guest && (
              <div className="wizard-input-hint">Sign in to join shared projects.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function friendlyStarterLabel(s: Starter): string {
  // "vibe-aws:new-app" → "vibe-aws · New app"
  const niceName = s.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${s.pluginName} · ${niceName}`;
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}
