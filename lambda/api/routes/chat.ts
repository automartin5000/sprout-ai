import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import {
  AppendChatTurnInput,
  type ChatTurn,
} from '../../../shared/api-contract.js';
import { readClaims } from '../auth/claims.js';
import {
  chatSk,
  chatSkPrefix,
  putItem,
  queryByPrefix,
  userPk,
} from '../db/ddb.js';

interface ChatItem extends ChatTurn {
  pk: string;
  sk: string;
}

export const chatRoute = new Hono();

chatRoute.get('/:projectId/chat', async (c) => {
  const claims = readClaims(c);
  const projectId = c.req.param('projectId');
  const cursor = c.req.query('cursor');
  const limit = Number.parseInt(c.req.query('limit') ?? '50', 10);

  const { items, nextCursor } = await queryByPrefix<ChatItem>({
    pk: userPk(claims.sub),
    skPrefix: chatSkPrefix(projectId),
    limit: Number.isFinite(limit) ? limit : 50,
    scanIndexForward: true,
    cursor,
  });

  const turns: ChatTurn[] = items.map(({ pk: _pk, sk: _sk, ...rest }) => rest);
  return c.json({ turns, nextCursor });
});

chatRoute.post('/:projectId/chat', async (c) => {
  const claims = readClaims(c);
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  const input = AppendChatTurnInput.parse(body);

  const turn: ChatTurn = {
    turnId: input.turnId ?? uuid(),
    projectId,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls ?? [],
    selfHealing: input.selfHealing,
    ts: new Date().toISOString(),
  };

  await putItem({
    pk: userPk(claims.sub),
    sk: chatSk(projectId, turn.turnId),
    ...turn,
  });

  return c.json(turn, 201);
});
