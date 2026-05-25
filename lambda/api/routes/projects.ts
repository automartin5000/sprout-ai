import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import {
  CreateProjectInput,
  UpdateProjectStateInput,
  type Project,
} from '../../../shared/api-contract.js';
import { readClaims } from '../auth/claims.js';
import {
  getItem,
  putItem,
  queryByPrefix,
  updateItem,
  userPk,
  projectSk,
} from '../db/ddb.js';

interface ProjectItem extends Project {
  pk: string;
  sk: string;
}

export const projectsRoute = new Hono();

projectsRoute.get('/', async (c) => {
  const claims = readClaims(c);
  const { items, nextCursor } = await queryByPrefix<ProjectItem>({
    pk: userPk(claims.sub),
    skPrefix: 'PROJECT#',
    limit: 50,
  });
  // Filter out chat rows by ensuring sk is exactly the project root.
  const projects = items.filter((it) => it.sk === projectSk(it.projectId));
  return c.json({ projects, nextCursor });
});

projectsRoute.post('/', async (c) => {
  const claims = readClaims(c);
  const body = await c.req.json();
  const input = CreateProjectInput.parse(body);
  const now = new Date().toISOString();
  const projectId = uuid();

  const project: Project = {
    projectId,
    ownerSub: claims.sub,
    name: input.name,
    slug: input.slug,
    createdAt: now,
    lastOpenedAt: now,
    harnessId: input.harnessId ?? 'copilot',
    modelId: input.modelId,
    pluginOverrides: [],
  };

  await putItem({
    pk: userPk(claims.sub),
    sk: projectSk(projectId),
    ...project,
  });

  return c.json(project, 201);
});

projectsRoute.get('/:id', async (c) => {
  const claims = readClaims(c);
  const id = c.req.param('id');
  const item = await getItem<ProjectItem>(userPk(claims.sub), projectSk(id));
  if (!item) return c.json({ error: 'not found' }, 404);
  const { pk: _pk, sk: _sk, ...project } = item;
  return c.json(project);
});

projectsRoute.put('/:id/state', async (c) => {
  const claims = readClaims(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const input = UpdateProjectStateInput.parse(body);

  await updateItem({
    pk: userPk(claims.sub),
    sk: projectSk(id),
    updates: input,
  });

  const refreshed = await getItem<ProjectItem>(
    userPk(claims.sub),
    projectSk(id),
  );
  if (!refreshed) return c.json({ error: 'not found' }, 404);
  const { pk: _pk, sk: _sk, ...project } = refreshed;
  return c.json(project);
});
