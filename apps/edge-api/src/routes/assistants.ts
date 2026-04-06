import { Hono } from 'hono';
import { z } from 'zod';
import { deleteAssistantRegistry, getAssistantUpstreamProfileId, upsertAssistantRegistry } from '../lib/assistant-registry';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import {
  forwardOpenAiProfileUtilityRequest,
  forwardOpenAiUtilityRequest,
  resolveUpstreamProfileIdForModel
} from '../lib/upstream';

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

async function readAssistantId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  const payload = await response.clone().json().catch(() => null) as { id?: unknown } | null;
  return typeof payload?.id === 'string' ? payload.id : null;
}

async function resolveAssistantProfileId(env: Env, assistantId: string): Promise<string | null> {
  return getAssistantUpstreamProfileId(env, assistantId);
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
    const upstreamProfileId = await resolveUpstreamProfileIdForModel(c.env, request.model, config);
    const response = await forwardOpenAiProfileUtilityRequest('/assistants', {
      method: 'POST',
      headers: assistantsBetaHeaders,
      body: JSON.stringify(request)
    }, config, upstreamProfileId);
    const assistantId = await readAssistantId(response);
    if (response.ok && assistantId) {
      await upsertAssistantRegistry(c.env, {
        assistantId,
        upstreamProfileId,
        model: request.model
      });
    }
    return response;
  });

  router.get('/v1/assistants/:assistantId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const assistantId = c.req.param('assistantId');
    const upstreamProfileId = await resolveAssistantProfileId(c.env, assistantId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
        method: 'GET',
        headers: listAssistantsHeaders
      }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
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
    const assistantId = c.req.param('assistantId');

    if (request.model) {
      const upstreamProfileId = await resolveUpstreamProfileIdForModel(c.env, request.model, config);
      const response = await forwardOpenAiProfileUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
        method: 'POST',
        headers: assistantsBetaHeaders,
        body: JSON.stringify(request)
      }, config, upstreamProfileId);
      if (response.ok) {
        await upsertAssistantRegistry(c.env, {
          assistantId,
          upstreamProfileId,
          model: request.model
        });
      }
      return response;
    }

    const upstreamProfileId = await resolveAssistantProfileId(c.env, assistantId);
    if (upstreamProfileId) {
      return forwardOpenAiProfileUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
        method: 'POST',
        headers: assistantsBetaHeaders,
        body: JSON.stringify(request)
      }, config, upstreamProfileId);
    }

    return forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
      method: 'POST',
      headers: assistantsBetaHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/assistants/:assistantId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const assistantId = c.req.param('assistantId');
    const upstreamProfileId = await resolveAssistantProfileId(c.env, assistantId);
    const response = upstreamProfileId
      ? await forwardOpenAiProfileUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
        method: 'DELETE',
        headers: listAssistantsHeaders
      }, config, upstreamProfileId)
      : await forwardOpenAiUtilityRequest(`/assistants/${encodeURIComponent(assistantId)}`, {
        method: 'DELETE',
        headers: listAssistantsHeaders
      }, config);

    if (response.ok) {
      await deleteAssistantRegistry(c.env, assistantId);
    }

    return response;
  });

  return router;
}
