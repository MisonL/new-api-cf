import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const createConversationRequestSchema = z.object({
  items: z.array(z.unknown()).max(20).optional(),
  metadata: z.record(z.string(), z.string()).optional()
}).passthrough();

const updateConversationRequestSchema = z.object({
  metadata: z.record(z.string(), z.string())
}).passthrough();

const createConversationItemsRequestSchema = z.object({
  items: z.array(z.unknown()).min(1).max(20)
}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createConversationsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/conversations', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createConversationRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/conversations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/conversations/:conversationId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}`, {
      method: 'GET'
    }, config);
  });

  router.post('/v1/conversations/:conversationId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = updateConversationRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/conversations/:conversationId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}`, {
      method: 'DELETE'
    }, config);
  });

  router.get('/v1/conversations/:conversationId/items', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}/items${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET'
    }, config);
  });

  router.post('/v1/conversations/:conversationId/items', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createConversationItemsRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}/items`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/conversations/:conversationId/items/:itemId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}/items/${encodeURIComponent(c.req.param('itemId'))}${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET'
    }, config);
  });

  router.delete('/v1/conversations/:conversationId/items/:itemId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/conversations/${encodeURIComponent(c.req.param('conversationId'))}/items/${encodeURIComponent(c.req.param('itemId'))}`, {
      method: 'DELETE'
    }, config);
  });

  return router;
}
