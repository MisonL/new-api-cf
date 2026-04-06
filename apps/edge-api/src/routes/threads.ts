import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const threadBetaHeaders = {
  'content-type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
} as const;

const threadBetaGetHeaders = {
  'OpenAI-Beta': 'assistants=v2'
} as const;

const threadCreateRequestSchema = z.object({}).passthrough();
const threadUpdateRequestSchema = z.object({}).passthrough();

const threadMessageCreateRequestSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.unknown()
}).passthrough();

const threadMessageUpdateRequestSchema = z.object({}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createThreadsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/threads', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = threadCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/threads', {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/threads/:threadId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(c.req.param('threadId'))}`, {
      method: 'GET',
      headers: threadBetaGetHeaders
    }, config);
  });

  router.post('/v1/threads/:threadId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = threadUpdateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(c.req.param('threadId'))}`, {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/threads/:threadId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(c.req.param('threadId'))}`, {
      method: 'DELETE',
      headers: threadBetaGetHeaders
    }, config);
  });

  router.post('/v1/threads/:threadId/messages', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = threadMessageCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(c.req.param('threadId'))}/messages`, {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/threads/:threadId/messages', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(c.req.param('threadId'))}/messages${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'GET',
        headers: threadBetaGetHeaders
      },
      config
    );
  });

  router.get('/v1/threads/:threadId/messages/:messageId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(c.req.param('threadId'))}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
      {
        method: 'GET',
        headers: threadBetaGetHeaders
      },
      config
    );
  });

  router.post('/v1/threads/:threadId/messages/:messageId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = threadMessageUpdateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(c.req.param('threadId'))}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
      {
        method: 'POST',
        headers: threadBetaHeaders,
        body: JSON.stringify(request)
      },
      config
    );
  });

  router.delete('/v1/threads/:threadId/messages/:messageId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(c.req.param('threadId'))}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
      {
        method: 'DELETE',
        headers: threadBetaGetHeaders
      },
      config
    );
  });

  return router;
}
