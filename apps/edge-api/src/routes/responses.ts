import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { deleteResponseRegistry, getResponseUpstreamProfileId, upsertResponseRegistry } from '../lib/response-registry';
import { discoverOpenAiProfileId, forwardOpenAiModelUtilityRequest, forwardOpenAiProfileUtilityRequest, forwardOpenAiUtilityRequest, forwardResponseCreate, resolveUpstreamProfileIdForModel } from '../lib/upstream';
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

async function readResponseId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  const payload = await response.clone().json().catch(() => null) as { id?: unknown } | null;
  return typeof payload?.id === 'string' ? payload.id : null;
}

async function resolveResponseProfileId(env: Env, responseId: string, config: ReturnType<typeof getRuntimeConfig>) {
  return (await getResponseUpstreamProfileId(env, responseId))
    || await discoverOpenAiProfileId(`/responses/${encodeURIComponent(responseId)}`, { method: 'GET' }, config)
    || config.defaultUpstreamProfileId
    || null;
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
    const upstreamProfileId = await resolveUpstreamProfileIdForModel(c.env, request.model, config);
    const response = await forwardResponseCreate(c.env, request, config, access);
    const responseId = await readResponseId(response);
    if (response.ok && responseId) {
      await upsertResponseRegistry(c.env, {
        responseId,
        upstreamProfileId,
        model: request.model
      });
    }
    return response;
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
    const responseId = c.req.param('responseId');
    const upstreamProfileId = await resolveResponseProfileId(c.env, responseId, config);
    if (upstreamProfileId) {
      await upsertResponseRegistry(c.env, {
        responseId,
        upstreamProfileId
      });
      return forwardOpenAiProfileUtilityRequest(`/responses/${encodeURIComponent(responseId)}${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(responseId)}${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.delete('/v1/responses/:responseId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const responseId = c.req.param('responseId');
    const upstreamProfileId = await resolveResponseProfileId(c.env, responseId, config);
    const response = upstreamProfileId
      ? await forwardOpenAiProfileUtilityRequest(`/responses/${encodeURIComponent(responseId)}`, { method: 'DELETE' }, config, upstreamProfileId)
      : await forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(responseId)}`, { method: 'DELETE' }, config);
    if (response.ok) {
      await deleteResponseRegistry(c.env, responseId);
    }
    return response;
  });

  router.post('/v1/responses/:responseId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const responseId = c.req.param('responseId');
    const upstreamProfileId = await resolveResponseProfileId(c.env, responseId, config);
    if (upstreamProfileId) {
      await upsertResponseRegistry(c.env, {
        responseId,
        upstreamProfileId
      });
      return forwardOpenAiProfileUtilityRequest(`/responses/${encodeURIComponent(responseId)}/cancel`, { method: 'POST' }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(responseId)}/cancel`, { method: 'POST' }, config);
  });

  router.get('/v1/responses/:responseId/input_items', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const responseId = c.req.param('responseId');
    const upstreamProfileId = await resolveResponseProfileId(c.env, responseId, config);
    if (upstreamProfileId) {
      await upsertResponseRegistry(c.env, {
        responseId,
        upstreamProfileId
      });
      return forwardOpenAiProfileUtilityRequest(`/responses/${encodeURIComponent(responseId)}/input_items${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config, upstreamProfileId);
    }
    return forwardOpenAiUtilityRequest(`/responses/${encodeURIComponent(responseId)}/input_items${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  return router;
}
