import { Hono } from 'hono';
import { z } from 'zod';
import { getAssistantUpstreamProfileId } from '../lib/assistant-registry';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { getThreadUpstreamProfileId, upsertThreadRegistry } from '../lib/thread-registry';
import { discoverOpenAiProfileId, forwardOpenAiProfileUtilityRequest, forwardOpenAiUtilityRequest } from '../lib/upstream';

const runBetaHeaders = {
  'content-type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
} as const;

const runBetaGetHeaders = {
  'OpenAI-Beta': 'assistants=v2'
} as const;

const createRunRequestSchema = z.object({
  assistant_id: z.string().min(1)
}).passthrough();

const createThreadAndRunRequestSchema = z.object({
  assistant_id: z.string().min(1)
}).passthrough();

const submitToolOutputsRequestSchema = z.object({
  tool_outputs: z.array(z.unknown()).min(1)
}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

async function readThreadId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  const payload = await response.clone().json().catch(() => null) as { thread_id?: unknown } | null;
  return typeof payload?.thread_id === 'string' ? payload.thread_id : null;
}

async function resolveAssistantProfileId(env: Env, assistantId: string, defaultProfileId: string | undefined) {
  return (await getAssistantUpstreamProfileId(env, assistantId)) || defaultProfileId || null;
}

async function resolveThreadProfileId(env: Env, threadId: string, defaultProfileId: string | undefined) {
  return (await getThreadUpstreamProfileId(env, threadId)) || defaultProfileId || null;
}

async function resolveExistingThreadProfileId(env: Env, threadId: string, config: ReturnType<typeof getRuntimeConfig>) {
  return (await getThreadUpstreamProfileId(env, threadId))
    || await discoverOpenAiProfileId(`/threads/${encodeURIComponent(threadId)}`, {
      method: 'GET',
      headers: runBetaGetHeaders
    }, config)
    || config.defaultUpstreamProfileId
    || null;
}

export function createRunsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/threads/runs', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createThreadAndRunRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const upstreamProfileId = await resolveAssistantProfileId(c.env, request.assistant_id, config.defaultUpstreamProfileId);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'assistant does not have a usable upstream profile', {
        assistantId: request.assistant_id
      });
    }

    const response = await forwardOpenAiProfileUtilityRequest('/threads/runs', {
      method: 'POST',
      headers: runBetaHeaders,
      body: JSON.stringify(request)
    }, config, upstreamProfileId);

    const threadId = await readThreadId(response);
    if (response.ok && threadId) {
      await upsertThreadRegistry(c.env, {
        threadId,
        upstreamProfileId
      });
    }

    return response;
  });

  router.post('/v1/threads/:threadId/runs', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createRunRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const threadProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    const assistantProfileId = await resolveAssistantProfileId(c.env, request.assistant_id, config.defaultUpstreamProfileId);

    if (!threadProfileId || !assistantProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread or assistant does not have a usable upstream profile', {
        threadId,
        assistantId: request.assistant_id
      });
    }

    if (threadProfileId !== assistantProfileId) {
      throw new ApiError(409, 'THREAD_ASSISTANT_PROFILE_MISMATCH', 'thread and assistant belong to different upstream profiles', {
        threadId,
        assistantId: request.assistant_id,
        threadUpstreamProfileId: threadProfileId,
        assistantUpstreamProfileId: assistantProfileId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId: threadProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'POST',
        headers: runBetaHeaders,
        body: JSON.stringify(request)
      },
      config,
      threadProfileId
    );
  });

  router.get('/v1/threads/:threadId/runs', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'GET',
        headers: runBetaGetHeaders
      },
      config,
      upstreamProfileId
    );
  });

  router.get('/v1/threads/:threadId/runs/:runId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(c.req.param('runId'))}${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'GET',
        headers: runBetaGetHeaders
      },
      config,
      upstreamProfileId
    );
  });

  router.post('/v1/threads/:threadId/runs/:runId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(c.req.param('runId'))}/cancel`,
      {
        method: 'POST',
        headers: runBetaGetHeaders
      },
      config,
      upstreamProfileId
    );
  });

  router.post('/v1/threads/:threadId/runs/:runId/submit_tool_outputs', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = submitToolOutputsRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(c.req.param('runId'))}/submit_tool_outputs`,
      {
        method: 'POST',
        headers: runBetaHeaders,
        body: JSON.stringify(request)
      },
      config,
      upstreamProfileId
    );
  });

  router.get('/v1/threads/:threadId/runs/:runId/steps', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(c.req.param('runId'))}/steps${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'GET',
        headers: runBetaGetHeaders
      },
      config,
      upstreamProfileId
    );
  });

  router.get('/v1/threads/:threadId/runs/:runId/steps/:stepId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);

    const threadId = c.req.param('threadId');
    const upstreamProfileId = await resolveExistingThreadProfileId(c.env, threadId, config);
    if (!upstreamProfileId) {
      throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'thread does not have a usable upstream profile', {
        threadId
      });
    }

    await upsertThreadRegistry(c.env, {
      threadId,
      upstreamProfileId
    });

    return forwardOpenAiProfileUtilityRequest(
      `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(c.req.param('runId'))}/steps/${encodeURIComponent(c.req.param('stepId'))}${buildQueryString(new URL(c.req.url))}`,
      {
        method: 'GET',
        headers: runBetaGetHeaders
      },
      config,
      upstreamProfileId
    );
  });

  return router;
}
