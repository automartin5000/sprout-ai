import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Persisted, user-level state that survives across app restarts. Lives at
 * `<userData>/state.json`. This is intentionally distinct from per-project
 * state (which lives in each project's worktree).
 */
export interface OnboardingState {
  /** Where new projects are created. Defaults to ~/sprout-projects. */
  projectsRoot?: string;
  /** True once the user has picked a path / accepted the default. */
  setupComplete: boolean;
  /** True if the user clicked "Use as guest" — cloud features stay disabled. */
  guest: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  projectsRoot: undefined,
  setupComplete: false,
  guest: false,
};

export class OnboardingStateStore {
  private cache?: OnboardingState;

  constructor(private readonly filePath: string = path.join(app.getPath('userData'), 'state.json')) {}

  static defaultProjectsRoot(): string {
    return path.join(os.homedir(), 'sprout-projects');
  }

  async load(): Promise<OnboardingState> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<OnboardingState>;
      this.cache = { ...DEFAULT_STATE, ...parsed };
    } catch {
      this.cache = { ...DEFAULT_STATE };
    }
    return this.cache;
  }

  async save(patch: Partial<OnboardingState>): Promise<OnboardingState> {
    const current = await this.load();
    this.cache = { ...current, ...patch };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    return this.cache;
  }

  /** Resolve the effective projects root — explicit or default. */
  async effectiveProjectsRoot(): Promise<string> {
    const s = await this.load();
    return s.projectsRoot ?? OnboardingStateStore.defaultProjectsRoot();
  }
}
