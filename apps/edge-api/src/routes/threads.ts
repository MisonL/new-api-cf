import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { deleteThreadRegistry, getThreadUpstreamProfileId, upsertThreadRegistry } from '../lib/thread-registry';
import { forwardOpenAiProfileUtilityRequest, forwardOpenAiUtilityRequest } from '../lib/upstream';

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

async function readThreadId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  const payload = await response.clone().json().catch(() => null) as { id?: unknown } | null;
  return typeof payload?.id === 'string' ? payload.id : null;
}

async function resolveThreadProfileId(env: Env, threadId: string, defaultProfileId: string | undefined) {
  return (await getThreadUpstreamProfileId(env, threadId)) || defaultProfileId || null;
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
    const response = await forwardOpenAiUtilityRequest('/threads', {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
    const threadId = await readThreadId(response);
    if (response.ok && threadId && config.defaultUpstreamProfileId) {
      await upsertThreadRegistry(c.env, {
        threadId,
        upstreamProfileId: config.defaultUpstreamProfileId
      });
    }
    return response;
  });

  router.get('/v1/threads/:threadId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
        method: 'GET',
        headers: threadBetaGetHeaders
      }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
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
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
        method: 'POST',
        headers: threadBetaHeaders,
        body: JSON.stringify(request)
      }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/threads/:threadId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    const response = upstreamProfileId
      ? await forwardOpenAiProfileUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
        method: 'DELETE',
        headers: threadBetaGetHeaders
      }, config, upstreamProfileId)
      : await forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(threadId)}`, {
        method: 'DELETE',
        headers: threadBetaGetHeaders
      }, config);

    if (response.ok) {
      await deleteThreadRegistry(c.env, threadId);
    }

    return response;
  });

  router.post('/v1/threads/:threadId/messages', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = threadMessageCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(`/threads/${encodeURIComponent(threadId)}/messages`, {
        method: 'POST',
        headers: threadBetaHeaders,
        body: JSON.stringify(request)
      }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: threadBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/threads/:threadId/messages', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(
        `/threads/${encodeURIComponent(threadId)}/messages${buildQueryString(new URL(c.req.url))}`,
        {
          method: 'GET',
          headers: threadBetaGetHeaders
        },
        config,
        upstreamProfileId
      );
    }
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/messages${buildQueryString(new URL(c.req.url))}`,
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
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(
        `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
        {
          method: 'GET',
          headers: threadBetaGetHeaders
        },
        config,
        upstreamProfileId
      );
    }
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
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
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(
        `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
        {
          method: 'POST',
          headers: threadBetaHeaders,
          body: JSON.stringify(request)
        },
        config,
        upstreamProfileId
      );
    }
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
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
    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveThreadProfileId(c.env, threadId, config.defaultUpstreamProfileId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(
        `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
        {
          method: 'DELETE',
          headers: threadBetaGetHeaders
        },
        config,
        upstreamProfileId
      );
    }
    return forwardOpenAiUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(c.req.param('messageId'))}`,
      {
        method: 'DELETE',
        headers: threadBetaGetHeaders
      },
      config
    );
  });

  return router;
}
