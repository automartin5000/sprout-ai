import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { LoadedAgent, LoadedSkill } from '../harness/types.js';
import type { LoadedPlugin, PluginManifest, PluginPermissions } from './types.js';

export interface PluginDiscoveryOpts {
  bundledDir: string;
  userDir?: string;
  projectDir?: string;
}

/**
 * Walks plugin search roots (bundled → user → project), parses each plugin's
 * manifest and SKILL.md/agents/*.md files, returns a deduped + override-merged
 * list. Later entries shadow earlier ones by plugin name.
 */
export async function discoverPlugins(opts: PluginDiscoveryOpts): Promise<LoadedPlugin[]> {
  const roots = [opts.bundledDir, opts.userDir, opts.projectDir].filter(
    (r): r is string => Boolean(r),
  );
  const byName = new Map<string, LoadedPlugin>();

  for (const root of roots) {
    const plugins = await readPluginsFromRoot(root);
    for (const plugin of plugins) {
      byName.set(plugin.manifest.name, plugin);
    }
  }
  return [...byName.values()];
}

async function readPluginsFromRoot(root: string): Promise<LoadedPlugin[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const plugins: LoadedPlugin[] = [];
  for (const entry of entries) {
    const pluginRoot = path.join(root, entry);
    const stat = await fs.stat(pluginRoot).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const manifest = await readManifest(pluginRoot);
    if (!manifest) continue;

    const [skills, agents, permissions] = await Promise.all([
      readSkills(pluginRoot, manifest.name),
      readAgents(pluginRoot, manifest.name),
      readPermissions(pluginRoot),
    ]);

    plugins.push({ manifest, root: pluginRoot, skills, agents, permissions });
  }
  return plugins;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readManifest(pluginRoot: string): Promise<PluginManifest | undefined> {
  return readJsonIfExists<PluginManifest>(
    path.join(pluginRoot, '.claude-plugin/plugin.json'),
  );
}

async function readPermissions(pluginRoot: string): Promise<PluginPermissions> {
  const settings = await readJsonIfExists<{ permissions?: { allow?: string[] } }>(
    path.join(pluginRoot, 'settings.json'),
  );
  return { allow: settings?.permissions?.allow ?? [] };
}

async function readSkills(pluginRoot: string, pluginName: string): Promise<LoadedSkill[]> {
  const skillsDir = path.join(pluginRoot, 'skills');
  const entries = await fs.readdir(skillsDir).catch(() => [] as string[]);

  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    const skillDir = path.join(skillsDir, entry);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const raw = await fs.readFile(skillFile, 'utf8').catch(() => undefined);
    if (!raw) continue;

    const parsed = matter(raw);
    const data = parsed.data as { name?: string; description?: string };
    if (!data.name || !data.description) continue;

    skills.push({
      name: data.name,
      description: data.description,
      body: parsed.content,
      dir: skillDir,
      pluginName,
    });
  }
  return skills;
}

async function readAgents(pluginRoot: string, pluginName: string): Promise<LoadedAgent[]> {
  const agentsDir = path.join(pluginRoot, 'agents');
  const entries = await fs.readdir(agentsDir).catch(() => [] as string[]);

  const agents: LoadedAgent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const agentPath = path.join(agentsDir, entry);
    const raw = await fs.readFile(agentPath, 'utf8').catch(() => undefined);
    if (!raw) continue;

    const parsed = matter(raw);
    const data = parsed.data as { name?: string; description?: string; tools?: string };
    if (!data.name || !data.description) continue;

    agents.push({
      name: data.name,
      description: data.description,
      body: parsed.content,
      path: agentPath,
      tools: parseToolList(data.tools),
      pluginName,
    });
  }
  return agents;
}

function parseToolList(raw: string | undefined): string[] {
  if (!raw) return [];
  if (raw.trim() === '*') return ['*'];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * Translate a bash-glob allowlist (vibe-aws style settings.json) into a
 * single allowed predicate. Each pattern matches a command line prefix; `:*`
 * suffix means "any args" and is equivalent to allowing the prefix.
 */
export function compileBashAllowlist(patterns: string[]): (cmd: string) => boolean {
  const compiled = patterns.map((p) => {
    const noWrap = p.replace(/^Bash\(/, '').replace(/\)$/, '');
    const trimmed = noWrap.endsWith(':*') ? noWrap.slice(0, -2) : noWrap;
    return trimmed.trim();
  });

  return (cmd) => {
    const c = cmd.trim();
    return compiled.some((prefix) => prefix === c || c.startsWith(`${prefix} `));
  };
}
