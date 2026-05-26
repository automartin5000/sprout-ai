import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { customAlphabet } from 'nanoid';
import type { Project } from '../../../shared/api-contract.js';
import { Worktree } from './worktree.js';
import { DevServer } from './dev-server.js';

// Crockford base32 (no 0/O/1/I/L) — matches the Lambda@Edge router's
// PROJECT_ID_PATTERN. 8 chars gives ~10^12 keyspace, plenty for a single
// user's projects. Existing projects with UUID-format IDs continue to work
// (the edge router accepts both shapes).
const generateProjectId = customAlphabet('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 8);

export interface ProjectRecord {
  project: Project;
  worktree: Worktree;
  devServer?: DevServer;
}

export interface ProjectManagerOpts {
  /** Override for tests; falls back to Electron app userData. */
  rootDir?: string;
}

/**
 * Per-user disk layout:
 *   <rootDir>/projects/<slug>/                  → worktree
 *   <rootDir>/projects/<slug>/.sprout/state.json
 */
export class ProjectManager {
  private rootDir: string;
  private readonly active = new Map<string, ProjectRecord>();
  /** Dedupes in-flight startDevServer() calls per project. */
  private readonly pendingDevServerStart = new Map<string, Promise<string>>();

  constructor(opts: ProjectManagerOpts = {}) {
    this.rootDir = opts.rootDir
      ?? path.join(app.getPath('userData'), 'projects');
  }

  /** Where new projects will be created. */
  getRootDir(): string {
    return this.rootDir;
  }

  /** Update where new projects will be created. Existing in-memory records keep their original paths. */
  setRootDir(dir: string): void {
    this.rootDir = dir;
  }

  async create(input: { name: string; slug: string; harnessId?: Project['harnessId'] }): Promise<ProjectRecord> {
    const safeSlug = sanitizeSlug(input.slug);
    const projectRoot = path.join(this.rootDir, safeSlug);
    await fs.mkdir(projectRoot, { recursive: true });

    const worktree = await Worktree.create(projectRoot);

    const project: Project = {
      projectId: generateProjectId(),
      ownerSub: 'local',
      name: input.name,
      slug: safeSlug,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      harnessId: input.harnessId ?? 'copilot',
      pluginOverrides: [],
    };

    await writeState(projectRoot, { project });

    const record: ProjectRecord = { project, worktree };
    this.active.set(project.projectId, record);
    return record;
  }

  async open(projectId: string): Promise<ProjectRecord> {
    const existing = this.active.get(projectId);
    if (existing) return existing;

    const entries = await fs.readdir(this.rootDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const projectRoot = path.join(this.rootDir, entry);
      const state = await readState(projectRoot);
      if (state?.project.projectId === projectId) {
        const worktree = await Worktree.open(projectRoot);
        const record: ProjectRecord = { project: state.project, worktree };
        this.active.set(projectId, record);
        return record;
      }
    }
    throw new Error(`project not found: ${projectId}`);
  }

  async list(): Promise<Project[]> {
    const entries = await fs.readdir(this.rootDir).catch(() => [] as string[]);
    const projects: Project[] = [];
    for (const entry of entries) {
      const state = await readState(path.join(this.rootDir, entry));
      if (state) projects.push(state.project);
    }
    return projects;
  }

  async startDevServer(projectId: string): Promise<string> {
    const record = await this.open(projectId);
    if (record.devServer?.url) return record.devServer.url;

    // Dedupe concurrent starts: if one is already in flight for this
    // project, return the same promise. Without this, calls from
    // Onboarding.openProject and App.handleProjectOpen race each other
    // and spawn duplicate dev servers.
    const inFlight = this.pendingDevServerStart.get(projectId);
    if (inFlight) return inFlight;

    record.devServer = new DevServer();
    const starting = record.devServer.start({
      projectRoot: record.worktree.root,
      projectId,
    });
    this.pendingDevServerStart.set(projectId, starting);
    void starting.finally(() => this.pendingDevServerStart.delete(projectId));
    return starting;
  }

  /**
   * Has the worktree been used yet? "Used" here means there's at least one
   * non-git, non-state file in the project root. False for a freshly-created
   * project; true once the AI has scaffolded files. The renderer uses this
   * to suppress the "Hi, I'm <project>" hero + sample-prompt suggestions on
   * reopening — those imply a fresh start.
   */
  async hasContent(projectId: string): Promise<boolean> {
    const record = await this.open(projectId);
    const entries = await fs.readdir(record.worktree.root).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === '.git' || entry === '.sprout' || entry.startsWith('.DS_Store')) continue;
      return true;
    }
    return false;
  }

  async updateHarness(projectId: string, harnessId: Project['harnessId']): Promise<Project> {
    const record = await this.open(projectId);
    const updated: Project = { ...record.project, harnessId };
    record.project = updated;
    const projectRoot = path.join(this.rootDir, record.project.slug);
    await writeState(projectRoot, { project: updated });
    return updated;
  }

  /**
   * Permanently remove a project. Stops the dev server, deletes the worktree
   * directory (including its .git history and state.json), and drops the
   * in-memory record. Does NOT touch any cloud-side resources — published
   * apps stay live until cleaned up via the cloud API separately.
   */
  async delete(projectId: string): Promise<void> {
    // Resolve the project on disk even if it's not currently active.
    let projectRoot: string | undefined;
    let record = this.active.get(projectId);
    if (record) {
      projectRoot = path.join(this.rootDir, record.project.slug);
    } else {
      const entries = await fs.readdir(this.rootDir).catch(() => [] as string[]);
      for (const entry of entries) {
        const candidate = path.join(this.rootDir, entry);
        const state = await readState(candidate);
        if (state?.project.projectId === projectId) {
          projectRoot = candidate;
          break;
        }
      }
    }
    if (!projectRoot) throw new Error(`project not found: ${projectId}`);

    // Stop any running dev server before removing the files.
    if (record?.devServer) {
      await record.devServer.stop().catch(() => undefined);
    }
    this.active.delete(projectId);
    this.pendingDevServerStart.delete(projectId);

    // Use a sentinel — fs.rm with force: true tolerates "doesn't exist" but
    // we still want to surface real permission / I-O errors loudly.
    await fs.rm(projectRoot, { recursive: true, force: true });
  }

  async close(projectId: string): Promise<void> {
    const record = this.active.get(projectId);
    if (!record) return;
    await record.devServer?.stop();
    this.active.delete(projectId);
  }
}

interface PersistedState {
  project: Project;
}

function stateFile(projectRoot: string): string {
  return path.join(projectRoot, '.sprout', 'state.json');
}

async function writeState(projectRoot: string, state: PersistedState): Promise<void> {
  const file = stateFile(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

async function readState(projectRoot: string): Promise<PersistedState | undefined> {
  try {
    const raw = await fs.readFile(stateFile(projectRoot), 'utf8');
    return JSON.parse(raw) as PersistedState;
  } catch {
    return undefined;
  }
}

function sanitizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
