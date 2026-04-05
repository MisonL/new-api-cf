import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest, forwardResponseCreate } from '../lib/upstream';
import { responseCreateRequestSchema } from '../schemas/responses';

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createResponsesRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/responses', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = responseCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardResponseCreate(c.env, request, config, access);
  });

  router.get('/v1/responses/:responseId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(c.req.param('responseId'))}${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.delete('/v1/responses/:responseId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(c.req.param('responseId'))}`, { method: 'DELETE' }, config);
  });

  router.post('/v1/responses/:responseId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(c.req.param('responseId'))}/cancel`, { method: 'POST' }, config);
  });

  router.get('/v1/responses/:responseId/input_items', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(c.req.param('responseId'))}/input_items${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  return router;
}
