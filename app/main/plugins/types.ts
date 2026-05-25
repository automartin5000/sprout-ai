import type { LoadedAgent, LoadedSkill } from '../harness/types.js';

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  author?: { name?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
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
