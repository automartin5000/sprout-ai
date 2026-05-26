import type { LoadedAgent, LoadedSkill } from '../harness/types.js';

/**
 * Optional CI/CD provider block on a plugin manifest. When present, the
 * plugin declares itself as a deployment provider for Sprout's "Publish to
 * prod" feature — it ships templates (workflow YAMLs, `.projenrc.ts`,
 * `infra/`), a bootstrap script, and optional helper skills.
 *
 * The two known modes ship as separate plugins:
 *   - `sprout-cicd-github` (bundled with Sprout) — GitHub Actions
 *   - `sprout-cicd-jenkins` (installed by corp MDM) — Jenkins
 *
 * Sprout's main process picks at most one active provider per machine.
 */
export interface CicdManifest {
  /** Human-readable label shown in the deploy modal. */
  label: string;
  /** Relative path inside the plugin root — copied into the user's project. */
  templatesDir: string;
  /** Relative path to an executable script run in the user's project after copy. */
  bootstrapScript: string;
  /**
   * Which kind of git remote this provider talks to. `'github'` shells out to
   * `gh repo create`; `'jenkins'` defers remote-add to the bootstrap script.
   */
  remoteKind: 'github' | 'jenkins';
}

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  author?: { name?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  /** Present only on CI/CD-provider plugins. Absent on starter/regular plugins. */
  cicd?: CicdManifest;
}

export interface PluginPermissions {
  /** Bash command glob patterns the plugin's skills/agents may execute. */
  allow: string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  root: string;
  skills: LoadedSkill[];
  agents: LoadedAgent[];
  permissions: PluginPermissions;
}

/**
 * A CI/CD-provider view of a loaded plugin: same data, with the cicd manifest
 * required (non-optional) and template/script paths resolved to absolute paths
 * relative to the plugin root.
 */
export interface LoadedCicdProvider {
  pluginName: string;
  manifest: CicdManifest;
  /** Absolute path to the templates directory. */
  templatesDir: string;
  /** Absolute path to the bootstrap script. */
  bootstrapScript: string;
}
