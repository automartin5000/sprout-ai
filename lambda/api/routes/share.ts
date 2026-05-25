import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { CreateShareInput, type Share } from '../../../shared/api-contract.js';
import { readClaims } from '../auth/claims.js';
import { getItem, putItem, sharePk } from '../db/ddb.js';

interface ShareItem extends Share {
  pk: string;
  sk: string;
  ttl?: number;
}

export const shareRoute = new Hono();

shareRoute.post('/', async (c) => {
  const claims = readClaims(c);
  const body = await c.req.json();
  const input = CreateShareInput.parse(body);

  const token = uuid().replace(/-/g, '');
  const now = new Date();
  const expiresAt = input.ttlSeconds
    ? new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    : undefined;

  const share: Share = {
    code: token,
    token,
    projectId: input.projectId,
    ownerSub: claims.sub,
    grants: 'edit',
    createdAt: now.toISOString(),
    expiresAt,
  };

  await putItem({
    pk: sharePk(token),
    sk: 'META',
    ...share,
    ttl: input.ttlSeconds
      ? Math.floor(now.getTime() / 1000) + input.ttlSeconds
      : undefined,
  });

  return c.json(share, 201);
});

shareRoute.get('/:token', async (c) => {
  const token = c.req.param('token');
  const item = await getItem<ShareItem>(sharePk(token), 'META');
  if (!item) return c.json({ error: 'not found' }, 404);
  if (item.expiresAt && new Date(item.expiresAt).getTime() < Date.now()) {
    return c.json({ error: 'expired' }, 410);
  }
  const { pk: _pk, sk: _sk, ttl: _ttl, ...share } = item;
  return c.json(share);
});
