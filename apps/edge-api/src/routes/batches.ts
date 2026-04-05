import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const createBatchRequestSchema = z.object({
  input_file_id: z.string().min(1),
  endpoint: z.string().min(1),
  completion_window: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional()
});

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createBatchesRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/v1/batches', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/batches${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.post('/v1/batches', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createBatchRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/batches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/batches/:batchId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/batches/${encodeURIComponent(c.req.param('batchId'))}`, { method: 'GET' }, config);
  });

  router.post('/v1/batches/:batchId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/batches/${encodeURIComponent(c.req.param('batchId'))}/cancel`, { method: 'POST' }, config);
  });

  return router;
}
