import type { LoadedCicdProvider } from '../plugins/types.js';
import type { SproutConfigStore } from './sprout-config.js';

/**
 * Outcome of resolving "which CI/CD provider should we use on this machine?"
 *
 * The three terminal states the deploy UI needs to differentiate:
 *
 *   - `'active'`   — exactly one provider, ready to use
 *   - `'choose'`   — multiple providers installed and the user hasn't picked one
 *                    yet; UI should prompt + persist via `SproutConfigStore`
 *   - `'none'`     — no providers installed; "Publish to prod" is disabled
 */
export type ProviderResolution =
  | { kind: 'active'; provider: LoadedCicdProvider }
  | { kind: 'choose'; candidates: LoadedCicdProvider[] }
  | { kind: 'none' };

/**
 * Resolution priority:
 *
 *   1. `SPROUT_CICD_PROVIDER=<pluginName>` env var (dev/test override)
 *   2. `~/.sprout/config.json` `activeCicdProvider` field
 *   3. If exactly one provider is installed, auto-pick it
 *   4. If multiple are installed, return `'choose'` so the UI can prompt
 *   5. If zero are installed, return `'none'`
 *
 * Note: a config'd or env'd provider that ISN'T currently installed falls
 * through to the count-based rule. We don't error — a missing plugin is the
 * same as not configured, and the user can re-pick.
 */
export async function resolveActiveProvider(opts: {
  providers: LoadedCicdProvider[];
  config: SproutConfigStore;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderResolution> {
  const env = opts.env ?? process.env;
  const byName = new Map(opts.providers.map((p) => [p.pluginName, p]));

  // 1. Env var override
  const envChoice = env.SPROUT_CICD_PROVIDER;
  if (envChoice && byName.has(envChoice)) {
    return { kind: 'active', provider: byName.get(envChoice)! };
  }

  // 2. Persisted user choice
  const config = await opts.config.load();
  if (config.activeCicdProvider && byName.has(config.activeCicdProvider)) {
    return { kind: 'active', provider: byName.get(config.activeCicdProvider)! };
  }

  // 3-5. Count-based fallback
  if (opts.providers.length === 0) return { kind: 'none' };
  if (opts.providers.length === 1) return { kind: 'active', provider: opts.providers[0] };
  return { kind: 'choose', candidates: opts.providers };
}
