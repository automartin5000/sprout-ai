/**
 * Embedded local DynamoDB (dynalite) — one instance per Sprout app process.
 *
 * Started at app boot, shut down on quit. All user-project servers spawned
 * via DevServer get its endpoint injected via `AWS_ENDPOINT_URL_DYNAMODB`
 * along with fake-but-valid AWS credentials, so AI-written code that uses
 * the standard AWS SDK (`new DynamoDBClient({})`) Just Works locally —
 * same as it will in production Lambda.
 *
 * Data persists across app restarts: dynalite writes a LevelDB tree to
 * `<userData>/sprout-ddb/`. Wipe that folder to factory-reset.
 *
 * Trade-off vs official DynamoDB Local: dynalite is ~5 MB of pure Node and
 * requires no JRE; the official one needs ~200 MB of Java. dynalite covers
 * the core API (Get/Put/Update/Query/Scan/Delete/CreateTable/Batch* with
 * the common condition expressions). Transactions, Streams, and a few
 * gnarly condition-expression corners aren't fully supported. That's
 * acceptable for the AI-generated CRUD apps Sprout exists to host.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

// dynalite has no shipped TypeScript types; declare just what we use.
type DynaliteServer = {
  listen(port: number, cb: (err?: Error) => void): void;
  close(cb: (err?: Error) => void): void;
  address(): { port: number };
};
// Use a non-`require` identifier so esbuild doesn't recognize the call as
// CJS and try to inline dynalite + its native-bindings transitive deps into
// our ESM bundle. `packages: 'external'` skips bare-specifier `import`s but
// still walks `require('…')` calls. `createRequire`'d aliases sidestep that.
const nodeRequire = createRequire(import.meta.url);
const dynalite = nodeRequire('dynalite') as (opts?: {
  path?: string;
  createTableMs?: number;
  deleteTableMs?: number;
  updateTableMs?: number;
  maxItemSizeKb?: number;
}) => DynaliteServer;

/** Name of the shared per-app DynamoDB table all Sprout projects use locally. */
export const SPROUT_LOCAL_TABLE = 'sprout-local';

export interface LocalDdb {
  endpoint: string;
  port: number;
  /** Path on disk where dynalite stores its LevelDB tree. */
  dataPath: string;
  stop(): Promise<void>;
}

let active: LocalDdb | undefined;

/**
 * Start dynalite on an ephemeral port and ensure the `sprout-local` table
 * exists. Idempotent — calling twice returns the same handle.
 *
 * `dataPath` defaults to `<userData>/sprout-ddb` when called from the main
 * process; tests pass a tmpdir so they don't depend on electron being up.
 */
export async function startLocalDdb(opts: { dataPath: string }): Promise<LocalDdb> {
  if (active) return active;

  const dataPath = opts.dataPath;
  await fs.mkdir(dataPath, { recursive: true });

  const server = dynalite({
    path: dataPath,
    // Skip the artificial CreateTable delay dynalite uses to mimic real DDB —
    // we want the table ready immediately on first boot.
    createTableMs: 0,
    deleteTableMs: 0,
    updateTableMs: 0,
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, (err) => (err ? reject(err) : resolve(server.address().port)));
  });
  const endpoint = `http://127.0.0.1:${port}`;
  await ensureSproutTable(endpoint);

  active = {
    endpoint,
    port,
    dataPath,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          active = undefined;
          resolve();
        });
      }),
  };
  return active;
}

export function getLocalDdb(): LocalDdb | undefined {
  return active;
}

async function ensureSproutTable(endpoint: string): Promise<void> {
  const ddb = new DynamoDBClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: SPROUT_LOCAL_TABLE,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (err) {
    // Table already exists on subsequent boots — fine, no-op.
    if ((err as Error).name !== 'ResourceInUseException') {
      throw err;
    }
  } finally {
    ddb.destroy();
  }
}
