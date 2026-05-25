import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME ?? 'sprout';

const baseClient = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export function userPk(sub: string): string {
  return `USER#${sub}`;
}
export function projectSk(projectId: string): string {
  return `PROJECT#${projectId}`;
}
export function chatSk(projectId: string, turnId: string): string {
  return `PROJECT#${projectId}#CHAT#${turnId}`;
}
export function chatSkPrefix(projectId: string): string {
  return `PROJECT#${projectId}#CHAT#`;
}
export function sharePk(token: string): string {
  return `SHARE#${token}`;
}
export function projectPk(projectId: string): string {
  return `PROJECT#${projectId}`;
}
export function publishSk(envId: string): string {
  return `PUBLISH#${envId}`;
}
export function publishSkPrefix(): string {
  return 'PUBLISH#';
}
export function collabSk(sub: string): string {
  return `COLLAB#${sub}`;
}
export function jobPk(jobId: string): string {
  return `JOB#${jobId}`;
}

/**
 * Phase 3: the runtime Lambda reads `PROJECT#<id> / META` to discover the
 * current published version. The API bumps `version` on publish complete.
 */
export function projectMetaSk(): string {
  return 'META';
}

/** Sort key for the host→project mapping the edge router uses. */
export function hostPk(host: string): string {
  return `HOST#${host}`;
}

export async function putItem(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

export async function getItem<T = Record<string, unknown>>(
  pk: string,
  sk: string,
): Promise<T | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk } }),
  );
  return res.Item as T | undefined;
}

export async function queryByPrefix<T = Record<string, unknown>>(opts: {
  pk: string;
  skPrefix: string;
  limit?: number;
  scanIndexForward?: boolean;
  cursor?: string;
}): Promise<{ items: T[]; nextCursor?: string }> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skp)',
      ExpressionAttributeValues: { ':pk': opts.pk, ':skp': opts.skPrefix },
      Limit: opts.limit ?? 50,
      ScanIndexForward: opts.scanIndexForward ?? true,
      ExclusiveStartKey: opts.cursor
        ? JSON.parse(Buffer.from(opts.cursor, 'base64').toString('utf8'))
        : undefined,
    }),
  );
  return {
    items: (res.Items ?? []) as T[],
    nextCursor: res.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64')
      : undefined,
  };
}

export async function updateItem(opts: {
  pk: string;
  sk: string;
  updates: Record<string, unknown>;
}): Promise<void> {
  const entries = Object.entries(opts.updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = entries.map(([key, value], i) => {
    const nameKey = `#n${i}`;
    const valKey = `:v${i}`;
    names[nameKey] = key;
    values[valKey] = value;
    return `${nameKey} = ${valKey}`;
  });

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: opts.pk, sk: opts.sk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
