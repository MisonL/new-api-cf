import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardEmbeddingsCreate } from '../lib/upstream';
import { embeddingsCreateRequestSchema } from '../schemas/embeddings';

export function createEmbeddingsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/embeddings', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = embeddingsCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardEmbeddingsCreate(c.env, request, config, access);
  });

  return router;
}
