import { Hono } from 'hono';
import { buildModelList, ensureUpstreamReady } from '../lib/upstream';
import { getRuntimeConfig } from '../lib/config';
import { ok } from '../lib/http';
import type { Context } from 'hono';

function createModelPayload(c: Context<{ Bindings: Env }>) {
  const config = getRuntimeConfig(c.env);
  ensureUpstreamReady(config);
  return {
    object: 'list',
    data: buildModelList(config)
  };
}

export function createModelRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/models', (c) => {
    return ok(c, createModelPayload(c));
  });

  router.get('/v1/models', (c) => {
    const payload = createModelPayload(c);
    return c.json(payload);
  });

  return router;
}
