import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardImageGeneration } from '../lib/upstream';
import { imageGenerationRequestSchema } from '../schemas/images';

export function createImagesRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/images/generations', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = imageGenerationRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardImageGeneration(c.env, request, config, access);
  });

  return router;
}
