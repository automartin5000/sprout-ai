import { describe, expect, it } from 'vitest';
import {
  CreateProjectInput,
  ProjectSchema,
} from '../shared/api-contract.js';
import { buildAuth0Audience, resolveEnvironment } from '../shared/environments.js';
import { compileBashAllowlist } from '../app/main/plugins/loader.js';

describe('api-contract', () => {
  it('parses a minimal CreateProjectInput', () => {
    const parsed = CreateProjectInput.parse({ name: 'TODO', slug: 'todo' });
    expect(parsed.name).toBe('TODO');
    expect(parsed.slug).toBe('todo');
  });

  it('Project schema requires projectId and ownerSub', () => {
    expect(() =>
      ProjectSchema.parse({ name: 'x', slug: 'x' }),
    ).toThrow();
  });
});

describe('environments', () => {
  it('builds a default audience when hostedZone is absent', () => {
    expect(buildAuth0Audience('dev', undefined)).toBe(
      'https://api.sprout.local',
    );
  });
  it('builds a per-env audience when hostedZone is present', () => {
    expect(buildAuth0Audience('dev', 'example.com')).toBe(
      'https://api.dev.sprout.example.com',
    );
    expect(buildAuth0Audience('prod', 'example.com')).toBe(
      'https://api.sprout.example.com',
    );
  });
  it('resolveEnvironment returns the expected env name', () => {
    const env = resolveEnvironment('dev');
    expect(env.name).toBe('dev');
  });
});

describe('plugin allowlist', () => {
  it('matches an exact pattern', () => {
    const allowed = compileBashAllowlist(['Bash(pnpm:*)', 'Bash(cdk:*)']);
    expect(allowed('pnpm install')).toBe(true);
    expect(allowed('cdk deploy --all')).toBe(true);
    expect(allowed('rm -rf /')).toBe(false);
  });
});
