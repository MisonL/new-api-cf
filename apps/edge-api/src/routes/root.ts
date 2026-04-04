import { Hono } from 'hono';
import { ok } from '../lib/http';

export function createRootRouter() {
  const router = new Hono();

  router.get('/', (c) => {
    return ok(c, {
      name: 'new-api-cf',
      description: 'worker-first AI gateway skeleton',
      routes: [
        '/api/status',
        '/api/auth/session',
        '/api/me',
        '/api/models',
        '/v1/chat/completions'
      ]
    });
  });

  return router;
}

