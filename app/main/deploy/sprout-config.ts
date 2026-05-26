import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * User-level config at `~/.sprout/config.json`. Intentionally separate from
 * `OnboardingStateStore` (which lives under Electron's userData dir):
 *
 *   - This file is for **machine-wide** Sprout preferences that should survive
 *     a Sprout reinstall / userData wipe.
 *   - Corp setup / MDM can drop a file here without knowing where Electron
 *     stashes its data on macOS.
 *   - The OnboardingStateStore stays the source of truth for Electron-scoped
 *     state (welcome flow, guest mode, projects root choice).
 *
 * Schema kept deliberately small for v1. Add fields as needs surface.
 */
export interface SproutConfig {
  /**
   * Plugin name of the active CI/CD provider for "Publish to prod". One of:
   *   - 'sprout-cicd-github' (bundled with Sprout)
   *   - 'sprout-cicd-jenkins' (corp install)
   *   - any third-party plugin shipping a `cicd:` manifest block
   *
   * When unset, Sprout auto-picks if exactly one provider is installed;
   * surfaces a one-time picker if multiple are installed.
   */
  activeCicdProvider?: string;
}

const DEFAULT: SproutConfig = {};

export class SproutConfigStore {
  private cache?: SproutConfig;

  constructor(
    private readonly filePath: string = path.join(os.homedir(), '.sprout', 'config.json'),
  ) {}

  async load(): Promise<SproutConfig> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SproutConfig>;
      this.cache = { ...DEFAULT, ...parsed };
    } catch {
      this.cache = { ...DEFAULT };
    }
    return this.cache;
  }

  async save(patch: Partial<SproutConfig>): Promise<SproutConfig> {
    const current = await this.load();
    this.cache = { ...current, ...patch };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    return this.cache;
  }
}
