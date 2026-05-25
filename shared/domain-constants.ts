import type { EnvName } from './environments.js';

export interface DomainOpts {
  envName: EnvName;
  hostedZone: string;
  service?: string;
}

export const SERVICES = {
  API: { subdomain: 'api', name: 'sprout-api' },
} as const;

export function buildApiDomain(opts: DomainOpts): string {
  const { envName, hostedZone } = opts;
  const prefix = envName === 'prod' ? '' : `${envName}.`;
  return `api.${prefix}sprout.${hostedZone}`;
}

export function buildApiUrl(opts: DomainOpts): string {
  return `https://${buildApiDomain(opts)}`;
}
