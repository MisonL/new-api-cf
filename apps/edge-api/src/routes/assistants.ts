import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiModelUtilityRequest, forwardOpenAiUtilityRequest } from '../lib/upstream';

const assistantsBetaHeaders = {
  'content-type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
} as const;

const listAssistantsHeaders = {
  'OpenAI-Beta': 'assistants=v2'
} as const;

const createAssistantRequestSchema = z.object({
  model: z.string().min(1)
}).passthrough();

const updateAssistantRequestSchema = z.object({
  model: z.string().min(1).optional()
}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createAssistantsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/v1/assistants', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/assistants${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: listAssistantsHeaders
    }, config);
  });

  router.post('/v1/assistants', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createAssistantRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(c.env, '/assistants', request.model, {
      method: 'POST',
      headers: assistantsBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/assistants/:assistantId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(c.req.param('assistantId'))}`, {
      method: 'GET',
      headers: listAssistantsHeaders
    }, config);
  });

  router.post('/v1/assistants/:assistantId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = updateAssistantRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    if (request.model) {
      return forwardOpenAiModelUtilityRequest(c.env, `/assistants/${encodeURIComponent(c.req.param('assistantId'))}`, request.model, {
        method: 'POST',
        headers: assistantsBetaHeaders,
        body: JSON.stringify(request)
      }, config);
    }

    return forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(c.req.param('assistantId'))}`, {
      method: 'POST',
      headers: assistantsBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/assistants/:assistantId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(c.req.param('assistantId'))}`, {
      method: 'DELETE',
      headers: listAssistantsHeaders
    }, config);
  });

  return router;
}
