import { awscdk } from 'projen';
import {
  NodePackageManager,
  TypeScriptJsxMode,
  TypeScriptModuleResolution,
} from 'projen/lib/javascript';

const project = new awscdk.AwsCdkTypeScriptApp({
  name: 'sprout',
  defaultReleaseBranch: 'main',
  cdkVersion: '2.190.0',
  appEntrypoint: '../infra/bin/app.ts',
  packageManager: NodePackageManager.BUN,
  projenCommand: 'bun .projenrc.ts',
  projenrcTs: true,
  projenVersion: '^0.95.0',
  buildCommand: undefined,
  depsUpgrade: false,
  github: false,
  licensed: false,
  sampleCode: false,
  vscode: true,
  eslint: true,
  eslintOptions: {
    dirs: ['app', 'lambda', 'infra', 'runtime', 'shared', 'scripts', 'tests'],
  },
  tsconfig: {
    compilerOptions: {
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      moduleResolution: TypeScriptModuleResolution.BUNDLER,
      target: 'ES2022',
      noEmit: true,
      module: 'esnext',
      jsx: TypeScriptJsxMode.REACT_JSX,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      rootDir: '.',
      typeRoots: ['./node_modules/@types', './types'],
    },
    include: ['app/**/*', 'lambda/**/*', 'infra/**/*', 'runtime/**/*', 'shared/**/*', 'scripts/**/*', 'tests/**/*'],
    exclude: [
      // Bundled-template node_modules and source: not part of our codebase.
      // They get copied verbatim into user projects at scaffold time;
      // type-checking them with our tsconfig produces ghost errors (e.g.
      // two copies of Vite types disagreeing).
      'app/resources/**',
      'node_modules',
    ],
  },
  deps: [
    // Lambda + AWS
    'hono',
    '@hono/node-server',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/lib-dynamodb',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@aws-sdk/client-lambda',
    'nanoid',
    'zod',
    'uuid',

    // Electron main / renderer
    'react',
    'react-dom',
    'gray-matter',
    'keytar',

    // Optional harnesses (dynamically imported in adapters)
    '@anthropic-ai/claude-agent-sdk',

    // Embedded local DynamoDB so user projects can use the real AWS SDK
    // against a transparent localhost endpoint while developing in Sprout.
    'dynalite',
  ],
  devDeps: [
    // Electron toolchain. Electron 42 ships Node 24 in the main process,
    // which silences the @aws-sdk/* "node >=22 required" warnings and lets
    // us use newer node:* APIs without polyfills.
    'electron@^42.0.0',
    'electron-builder@^25.0.0',
    'vite@^6.0.0',
    '@vitejs/plugin-react@^4.3.0',

    // Renderer
    '@types/react',
    '@types/react-dom',

    // Types & utilities
    '@types/uuid',
    '@types/node',

    // Test stack
    'vitest',
    '@playwright/test',

    // Lambda types
    '@types/aws-lambda',

    // Build helpers
    'esbuild',
    'tsx',
    'dotenv',
    'yaml',
  ],
});

// ----- gitignore -----
project.gitignore.exclude(
  // OS
  '.DS_Store',
  'Thumbs.db',
  // Env
  '.env',
  '.env.*',
  '!.env.example',
  // Electron / Vite build output
  'app/resources/bin/**',
  'app/resources/plugins/**',
  '!app/resources/**/.gitkeep',
  'dist-electron',
  'dist-renderer',
  'release',
  // Vite timestamps
  'vite.config.js.timestamp-*',
  'vite.config.ts.timestamp-*',
  // CDK
  'cdk.context.json',
  // Playwright
  'playwright-report',
  'test-results',
  // Sanitization lockfile (regenerated each build)
  'plugins.lock.json',
);

project.addFields({ type: 'module' });

// ----- Replace Jest test runner with Vitest -----
project.testTask.reset();
project.testTask.exec('vitest run');

// ----- TypeScript strict type-check ahead of compile -----
const typeCheckTask = project.addTask('type-check', {
  description: 'Type check TypeScript files with strict mode',
  exec: 'tsc --noEmit --strict --project tsconfig.dev.json',
});
project.compileTask.prependSpawn(typeCheckTask);

// ----- Build steps: download binaries + sanitize plugin -----
const downloadBinariesTask = project.addTask('binaries:download', {
  description: 'Download Node, git, AWS CLI, Podman into app/resources/bin per-arch',
  exec: 'bunx tsx scripts/download-binaries.ts',
});

const stageSproutPluginTask = project.addTask('plugins:stage-sprout', {
  description: 'Stage the first-party sprout plugin into app/resources/plugins/sprout',
  exec: 'bunx tsx scripts/stage-sprout-plugin.ts',
});

const stageResourcesTask = project.addTask('app:stage-resources', {
  description: 'Stage extraResources (binaries + plugins) for the Electron build',
});
stageResourcesTask.spawn(downloadBinariesTask);
stageResourcesTask.spawn(stageSproutPluginTask);

// Stage the sprout plugin on every compile so editing plugins/sprout/ during
// dev shows up immediately in `pj app:dev` (the plugin loader picks up
// app/resources/plugins/* at runtime).
project.compileTask.spawn(stageSproutPluginTask);

// ----- Electron app tasks -----
project.addTask('app:dev', {
  description: 'Run the Electron app with hot-reload Vite renderer',
  exec: 'bunx tsx scripts/dev-electron.ts',
});

project.addTask('app:build:renderer', {
  description: 'Build the Electron renderer (Vite)',
  exec: 'vite build --config app/renderer/vite.config.ts',
});

project.addTask('app:build:main', {
  description: 'Build the Electron main + preload (esbuild)',
  exec: 'bunx tsx scripts/build-electron-main.ts',
});

const appBuildTask = project.addTask('app:build', {
  description: 'Build Electron renderer + main + preload',
});
appBuildTask.spawn(project.tasks.tryFind('app:build:renderer')!);
appBuildTask.spawn(project.tasks.tryFind('app:build:main')!);

project.addTask('app:package', {
  description: 'Package the Mac app DMGs (per-arch) via electron-builder',
  exec: 'electron-builder --mac --config electron-builder.yml',
});

// ----- Lambda bundle task -----
project.addTask('lambda:build', {
  description: 'Bundle the Hono Lambda with esbuild',
  exec: 'bunx tsx scripts/build-lambda.ts',
});

// ----- Runtime + Lambda@Edge bundle task -----
project.addTask('runtime:build', {
  description: 'Bundle the shared runtime Lambda + Lambda@Edge router',
  exec: 'bunx tsx scripts/build-runtime.ts',
});

// ----- Wire the build order: lambda bundle + runtime bundle + app build before CDK synth -----
project.compileTask.exec('bun run lambda:build');
project.compileTask.exec('bun run runtime:build');
project.compileTask.exec('bun run app:build');

// ----- CDK helpers -----
project.cdkTasks.deploy.prependExec('echo "Deploying to $DEPLOY_ENV"');
project.cdkTasks.deploy.prependSpawn(project.compileTask);

project.addTask('cdk:bootstrap', {
  description: 'Bootstrap the CDK environment',
  exec: 'cdk bootstrap',
  receiveArgs: true,
});

// ----- VSCode settings -----
project.vscode?.settings.addSettings(
  {
    'editor.tabSize': 2,
    'editor.insertSpaces': true,
    'editor.detectIndentation': false,
  },
  'typescript',
);

// ----- Fix default task so `bun .projenrc.ts` is the entrypoint -----
project.defaultTask?.reset('bun .projenrc.ts');

project.synth();
