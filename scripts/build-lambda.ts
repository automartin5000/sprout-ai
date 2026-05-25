import { build } from 'esbuild';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  await build({
    entryPoints: [path.join(root, 'lambda/api/index.ts')],
    outfile: path.join(root, 'dist-lambda/api/index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: 'linked',
    external: ['@aws-sdk/*'],
    minify: true,
    logLevel: 'info',
  });
}

void main();
