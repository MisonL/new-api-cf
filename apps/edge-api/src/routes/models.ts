import { Hono } from 'hono';
import { ensureUpstreamReady, resolveModelCatalog } from '../lib/upstream';
import { getRuntimeConfig } from '../lib/config';
import { ok } from '../lib/http';
import type { Context } from 'hono';
import { requireRelayAccess } from '../lib/relay-auth';

async function createModelPayload(c: Context<{ Bindings: Env }>) {
  const config = getRuntimeConfig(c.env);
  ensureUpstreamReady(config);
  const catalog = await resolveModelCatalog(c.env, config);
  return {
    object: 'list',
    stateStore: catalog.stateStore,
    data: catalog.models
  };
}

export function createModelRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/models', async (c) => {
    return ok(c, await createModelPayload(c));
  });

  router.get('/v1/models', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireRelayAccess(c, config);
    const payload = await createModelPayload(c);
    return c.json(payload);
  });

  return router;
}
