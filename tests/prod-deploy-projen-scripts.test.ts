/**
 * Regression test for the Promote-to-prod "dev scripts wiped" bug.
 *
 * Background: when projen synth runs on a Sprout-promoted project, it
 * REGENERATES `package.json` from the template's `.projenrc.ts`. If the
 * `.projenrc.ts` doesn't declare the hono-react dev/build scripts via
 * `project.package.setScript()`, they get wiped — which breaks the
 * DevServer's preview spawn (no `dev` script to run) and Sprout's
 * Share-preview build (no `build:client` / `build:server`).
 *
 * The fix lives in `plugins/sprout-cicd-github/templates/.projenrc.ts`:
 * it calls setScript() for each Sprout-managed script so they become
 * projen-managed and survive every regen.
 *
 * This test exercises the SAME projen + AwsCdkTypeScriptApp shape the
 * template uses, then re-applies the SAME setScript() calls, and asserts
 * the resulting package.json has every required script. We import projen
 * directly (instead of spawning `tsx .projenrc.ts`) because (a) it's
 * faster and (b) projen's synth writes a node_modules into the tmp dir
 * containing files with corrupted inline source maps — when vitest tries
 * to symbolicate any subsequent error, it walks into that node_modules
 * and chokes on the bad source map, producing an unhandled SyntaxError
 * that masks the real test signal.
 *
 * Trade-off: this test replicates `.projenrc.ts`'s body inline rather
 * than executing the file. If someone updates `.projenrc.ts` to add a
 * new setScript() call but doesn't update this test, the new script
 * isn't checked. To mitigate, we also assert against the EXACT set of
 * scripts the template declares — anything added to the template that
 * isn't asserted here will trigger a drift warning.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awscdk, javascript } from 'projen';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PROJENRC = path.join(
  REPO_ROOT,
  'plugins/sprout-cicd-github/templates/.projenrc.ts',
);

describe('sprout-cicd-github .projenrc.ts script preservation', () => {
  let outdir: string;

  beforeEach(async () => {
    outdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprout-projenrc-'));
  });

  afterEach(async () => {
    if (process.env.SPROUT_KEEP_TMP) return;
    await fs.rm(outdir, { recursive: true, force: true });
  });

  it('preserves Sprout dev/build scripts when projen synths', async () => {
    // Build the same projen project as the template does, pointed at our
    // tmp outdir. The setScript() calls below MUST mirror what the
    // template applies — if they drift, the drift-check at the bottom of
    // this test fails.
    const project = new awscdk.AwsCdkTypeScriptApp({
      outdir,
      name: 'test-app',
      defaultReleaseBranch: 'main',
      cdkVersion: '2.180.0',
      packageManager: javascript.NodePackageManager.BUN,
      appEntrypoint: 'infra/bin/app.ts',
      srcdir: 'infra',
      buildWorkflow: false,
      release: false,
      github: false,
      deps: [],
      devDeps: ['aws-cdk-lib@^2.180.0', 'constructs@^10.3.0'],
    });

    project.package.setScript(
      'dev',
      'concurrently -k -p "[{name}]" -n server,client -c green,blue "npm:dev:server" "npm:dev:client"',
    );
    project.package.setScript('dev:server', 'npx tsx watch server/index.ts');
    project.package.setScript(
      'dev:client',
      'wait-on tcp:127.0.0.1:5175 --timeout 60000 && vite',
    );
    project.package.setScript('build:client', 'vite build');
    project.package.setScript(
      'build:server',
      'npx esbuild server/index.ts --bundle --platform=node --target=node24 --format=cjs --outfile=server-dist/server.js --external:@aws-sdk/*',
    );

    // Projen's AwsCdkTypeScriptApp resolves `appEntrypoint` relative to
    // `srcdir`, so the template's config produces the path
    // `infra/infra/bin/app.ts`. In the real prod-deploy flow this is
    // silent because Sprout's copyTemplates step pre-creates the file
    // and projen's SampleCode skips existing paths. We mirror that here
    // so synth doesn't fail on a missing-parent-dir ENOENT.
    await fs.mkdir(path.join(outdir, 'infra', 'infra', 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(outdir, 'infra', 'infra', 'bin', 'app.ts'),
      '// stub for projen SampleCode skip\n',
      'utf8',
    );

    project.synth();

    const pkg = JSON.parse(
      await fs.readFile(path.join(outdir, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    // The five Sprout-managed scripts MUST survive. ANY missing one is
    // a regression that would silently break a user's promoted project.
    expect(scripts.dev, 'dev (top-level orchestrator)').toBeDefined();
    expect(scripts.dev).toContain('concurrently');
    expect(scripts['dev:server']).toBeDefined();
    expect(scripts['dev:server']).toContain('tsx');
    expect(scripts['dev:client']).toBeDefined();
    expect(scripts['dev:client']).toContain('vite');
    expect(scripts['build:client']).toBeDefined();
    expect(scripts['build:client']).toContain('vite build');
    expect(scripts['build:server']).toBeDefined();
    expect(scripts['build:server']).toContain('esbuild');

    // Projen's own `build` is also expected — we don't overwrite it.
    expect(scripts.build).toBeDefined();
  });

  it('the template .projenrc.ts calls setScript for every script this test pins', async () => {
    // Drift guard: if someone edits the template to add `setScript('foo', …)`,
    // they should add a matching expectation above. This grep + count check
    // makes the addition obvious.
    const template = await fs.readFile(TEMPLATE_PROJENRC, 'utf8');
    const setScriptCalls = (template.match(/setScript\(\s*['"]/g) ?? []).length;
    expect(
      setScriptCalls,
      'If you added/removed a setScript() call in templates/.projenrc.ts, ' +
      'update the assertions in the preceding test too.',
    ).toBe(5);

    // Cheap content checks — make sure the specific script names we
    // depend on are still in the template source. If anyone renames one
    // (e.g. `dev:server` → `serve`) this fails loudly.
    expect(template).toContain("setScript(\n  'dev',");
    expect(template).toContain("setScript('dev:server',");
    expect(template).toContain("setScript(\n  'dev:client',");
    expect(template).toContain("setScript('build:client',");
    expect(template).toContain("setScript(\n  'build:server',");
  });
});
