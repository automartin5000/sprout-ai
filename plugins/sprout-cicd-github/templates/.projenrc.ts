/**
 * projen config for a Sprout app deployed to AWS via GitHub Actions.
 *
 * Scaffolded by Sprout's `sprout-cicd-github` plugin. To modify the project
 * structure, edit this file and run `bun .projenrc.ts` (or `npx tsx .projenrc.ts`).
 * That will regenerate `cdk.json`, the workflow YAMLs, and any other projen-
 * managed files.
 *
 * Sprout substitutes `{{projectName}}` at copy time. Everything else here is
 * static — feel free to edit after scaffold.
 */
import { awscdk, javascript } from 'projen';

const PROJECT_NAME = '{{projectName}}';

const project = new awscdk.AwsCdkTypeScriptApp({
  name: PROJECT_NAME,
  defaultReleaseBranch: 'main',
  cdkVersion: '2.180.0',
  packageManager: javascript.NodePackageManager.BUN,
  appEntrypoint: 'infra/bin/app.ts',
  srcdir: 'infra',

  // The workflow YAMLs ship verbatim in the Sprout plugin templates dir.
  // projen would normally generate its own — we disable that so the hand-
  // tuned versions stick. Sprout's CI ensures they stay in sync.
  buildWorkflow: false,
  release: false,
  github: false,

  // Keep the dep set lean — the user's Sprout app already brings its own
  // build toolchain (vite, hono, etc.). projen only owns the CDK + infra
  // synthesis path.
  deps: [],
  devDeps: [
    'aws-cdk-lib@^2.180.0',
    'constructs@^10.3.0',
  ],
});

// ─────────────────────────────────────────────────────────────
// PRESERVE THE SPROUT HONO-REACT APP SCRIPTS
// ─────────────────────────────────────────────────────────────
//
// Sprout scaffolds user apps from `plugins/sprout/templates/hono-react/` which
// ships these scripts in its package.json. The dev-server in
// app/main/projects/dev-server.ts looks for `dev` (preferring it over
// `dev:server`) to spawn the preview; the Share-preview publish flow calls
// `build:client` + `build:server`.
//
// projen REGENERATES package.json from this config on every `bun .projenrc.ts`
// invocation. Any script that isn't declared here gets wiped — which is what
// happened to the user's `pick-a-game` project: after Promote to prod ran
// `bootstrap-prod.sh` (which invokes projen), the dev scripts were gone and
// the preview pane stayed empty.
//
// Declaring them here makes them projen-managed: every regen reapplies them,
// future projen upgrades preserve them, and the regression test in
// `tests/prod-deploy.test.ts` ensures any breakage shows up in CI.
//
// We deliberately do NOT overwrite `build` — projen owns that for the CDK
// pipeline (compile + test + synth). The user's app build is reached via
// `build:client` + `build:server` directly. (If/when Share-preview publishing
// of a promoted project is re-enabled, app/main/publish/client.ts should
// call those two scripts instead of `npm run build`.)
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

project.synth();
