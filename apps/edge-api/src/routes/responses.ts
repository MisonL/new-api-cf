import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiModelUtilityRequest, forwardOpenAiUtilityRequest, forwardResponseCreate } from '../lib/upstream';
import { responseCreateRequestSchema } from '../schemas/responses';

const responseInputTokensRequestSchema = z.object({
  model: z.string().min(1).optional()
}).passthrough();

const responseCompactRequestSchema = z.object({
  model: z.string().min(1)
}).passthrough();

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

  router.post('/v1/responses/input_tokens', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = responseInputTokensRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    if (request.model) {
      return forwardOpenAiModelUtilityRequest(c.env, '/responses/input_tokens', request.model, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(request)
      }, config);
    }

    return forwardOpenAiUtilityRequest('/responses/input_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.post('/v1/responses/compact', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = responseCompactRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(c.env, '/responses/compact', request.model, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
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
