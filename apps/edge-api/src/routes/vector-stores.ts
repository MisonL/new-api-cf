import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const createVectorStoreRequestSchema = z.object({
  name: z.string().min(1).optional(),
  file_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.string()).optional()
}).passthrough();

const vectorStoreSearchRequestSchema = z.object({
  query: z.string().min(1)
}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createVectorStoresRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/v1/vector_stores', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.post('/v1/vector_stores', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createVectorStoreRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/vector_stores', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}`, { method: 'GET' }, config);
  });

  router.delete('/v1/vector_stores/:vectorStoreId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}`, { method: 'DELETE' }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId/search', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = vectorStoreSearchRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  return router;
}
