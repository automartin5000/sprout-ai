import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { ZodError } from 'zod';
import { projectsRoute } from './routes/projects.js';
import { chatRoute } from './routes/chat.js';
import { shareRoute } from './routes/share.js';
import { publishRoute } from './routes/publish.js';
import { UnauthorizedError } from './auth/claims.js';

export const app = new Hono();

app.onError((err, c) => {
  if (err instanceof UnauthorizedError) {
    return c.json({ error: err.message }, 401);
  }
  if (err instanceof ZodError) {
    return c.json({ error: 'validation_failed', details: err.flatten() }, 400);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal_server_error' }, 500);
});

app.get('/healthz', (c) => c.json({ ok: true }));

// publishRoute owns /projects/:id/publish, /projects/:id/share, /jobs/:id,
// /share/:code/open, /share/:code/publish — mount it before shareRoute so its
// /share/:code/* paths take precedence over shareRoute's /:token route.
app.route('/', publishRoute);
app.route('/projects', projectsRoute);
app.route('/projects', chatRoute);
app.route('/share', shareRoute);

export const handler = handle(app);
export default app;
