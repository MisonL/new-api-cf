import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { getSessionInfo, requireAdmin } from '../lib/auth';
import { ok } from '../lib/http';

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/auth/session', (c) => {
    const config = getRuntimeConfig(c.env);
    return ok(c, getSessionInfo(c, config));
  });

  router.get('/api/me', (c) => {
    const config = getRuntimeConfig(c.env);
    const session = requireAdmin(c, config);
    return ok(c, session);
  });

  return router;
}

