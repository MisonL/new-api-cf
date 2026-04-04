import { Hono } from 'hono';
import { buildModelList, ensureUpstreamReady } from '../lib/upstream';
import { getRuntimeConfig } from '../lib/config';
import { ok } from '../lib/http';

export function createModelRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/models', (c) => {
    const config = getRuntimeConfig(c.env);
    ensureUpstreamReady(config);
    return ok(c, {
      object: 'list',
      data: buildModelList(config)
    });
  });

  return router;
}

