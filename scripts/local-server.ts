/**
 * Run the Hono API as a plain Node server on localhost, for local-test mode.
 * No AWS, no API Gateway authorizer — JWT is mocked when MOCK_AUTH=1.
 *
 *   MOCK_AUTH=1 PORT=3001 LOCAL_TABLE=./.sprout.json \
 *     bunx tsx scripts/local-server.ts
 *
 * The DynamoDB calls in lambda/api/db/ddb.ts will still try to talk to AWS
 * unless USE_LOCAL_DB=1, in which case we install an in-memory shim before
 * the Hono module loads.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { serve } from '@hono/node-server';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  // Mount the in-memory DDB shim before lambda imports its real client.
  if (process.env.USE_LOCAL_DB !== '0') {
    await installInMemoryDdb();
  }

  // Hono app is a regular Hono instance; we wrap it for Node by passing
  // it to @hono/node-server. We intentionally re-import the existing lambda
  // entrypoint so backend code is identical between Lambda and local.
  const apiModule = await import('../lambda/api/index.js');
  const app = (apiModule as { default?: unknown; handler?: unknown }).default
    ?? (apiModule as { app?: unknown }).app;

  if (!app) {
    // The Lambda entrypoint exports `handler` only; re-export the Hono app
    // by reading the module's internal binding. Easier path: have the
    // lambda entrypoint export the Hono instance too. Patched in the
    // related edit to lambda/api/index.ts.
    throw new Error(
      'lambda/api/index.ts must export the Hono app as `app` for local-server to mount it',
    );
  }

  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  serve({ fetch: (app as { fetch: (req: Request) => Promise<Response> }).fetch, port }, (info) => {
    console.log(`sprout API listening on http://localhost:${info.port}`);
    console.log(`  MOCK_AUTH=${process.env.MOCK_AUTH ?? '0'}  USE_LOCAL_DB=${process.env.USE_LOCAL_DB ?? '1'}`);
  });
}

/**
 * Replace @aws-sdk/lib-dynamodb's DocumentClient at import time with a
 * file-backed JSON store. Crude but enough for local testing.
 */
async function installInMemoryDdb(): Promise<void> {
  const Module = await import('node:module');
  const storeFile = process.env.LOCAL_TABLE
    ?? path.join(__dirname, '..', '.sprout.json');

  const store: Record<string, unknown> = await fs
    .readFile(storeFile, 'utf8')
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({}));

  async function persist(): Promise<void> {
    await fs.writeFile(storeFile, JSON.stringify(store, null, 2), 'utf8');
  }

  const fakeDocClient = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      const Item = input.Item as { pk: string; sk: string; [k: string]: unknown } | undefined;
      const Key = input.Key as { pk: string; sk: string } | undefined;

      switch (name) {
        case 'PutCommand': {
          if (!Item) return {};
          store[`${Item.pk}#${Item.sk}`] = Item;
          await persist();
          return {};
        }
        case 'GetCommand': {
          return { Item: Key ? store[`${Key.pk}#${Key.sk}`] : undefined };
        }
        case 'QueryCommand': {
          const expr = input.ExpressionAttributeValues as Record<string, string>;
          const pk = expr?.[':pk'];
          const skp = expr?.[':skp'];
          const items = Object.entries(store)
            .filter(([k]) => k.startsWith(`${pk}#`))
            .map(([, v]) => v)
            .filter((v) => !skp || (v as { sk?: string }).sk?.startsWith(skp));
          return { Items: items };
        }
        case 'UpdateCommand': {
          if (!Key) return {};
          const item = (store[`${Key.pk}#${Key.sk}`] as Record<string, unknown>) ?? {};
          const names = input.ExpressionAttributeNames as Record<string, string>;
          const values = input.ExpressionAttributeValues as Record<string, unknown>;
          if (names && values) {
            for (const [nameKey, attrName] of Object.entries(names)) {
              const valKey = nameKey.replace('#n', ':v');
              item[attrName] = values[valKey];
            }
          }
          store[`${Key.pk}#${Key.sk}`] = item;
          await persist();
          return {};
        }
        default:
          throw new Error(`local ddb shim: unsupported command ${name}`);
      }
    },
  };

  // Monkey-patch the module cache so `from()` returns our fake client.
  const realLib = await import('@aws-sdk/lib-dynamodb');
  (realLib.DynamoDBDocumentClient as unknown as { from: () => unknown }).from = () => fakeDocClient;
  void Module;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
