import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const vectorStoreWriteHeaders = {
  'content-type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
} as const;

const vectorStoreReadHeaders = {
  'OpenAI-Beta': 'assistants=v2'
} as const;

const createVectorStoreRequestSchema = z.object({
  name: z.string().min(1).optional(),
  file_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.string()).optional()
}).passthrough();

const vectorStoreSearchRequestSchema = z.object({
  query: z.string().min(1)
}).passthrough();

const updateVectorStoreRequestSchema = z.object({}).passthrough();

const createVectorStoreFileRequestSchema = z.object({
  file_id: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).optional(),
  chunking_strategy: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const updateVectorStoreFileRequestSchema = z.object({
  attributes: z.record(z.string(), z.unknown())
}).passthrough();

const createVectorStoreFileBatchRequestSchema = z.object({
  file_ids: z.array(z.string().min(1)).optional(),
  files: z.array(z.record(z.string(), z.unknown())).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  chunking_strategy: z.record(z.string(), z.unknown()).optional()
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
    return forwardOpenAiUtilityRequest(`/vector_stores${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
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
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = updateVectorStoreRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}`, {
      method: 'POST',
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/vector_stores/:vectorStoreId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}`, {
      method: 'DELETE',
      headers: vectorStoreReadHeaders
    }, config);
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
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/files', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId/files', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createVectorStoreFileRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files`, {
      method: 'POST',
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/files/:fileId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files/${encodeURIComponent(c.req.param('fileId'))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/files/:fileId/content', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files/${encodeURIComponent(c.req.param('fileId'))}/content${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId/files/:fileId', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = updateVectorStoreFileRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files/${encodeURIComponent(c.req.param('fileId'))}`, {
      method: 'POST',
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/vector_stores/:vectorStoreId/files/:fileId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/files/${encodeURIComponent(c.req.param('fileId'))}`, {
      method: 'DELETE',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/file_batches', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/file_batches${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId/file_batches', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createVectorStoreFileBatchRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/file_batches`, {
      method: 'POST',
      headers: vectorStoreWriteHeaders,
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/file_batches/:batchId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/file_batches/${encodeURIComponent(c.req.param('batchId'))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.post('/v1/vector_stores/:vectorStoreId/file_batches/:batchId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/file_batches/${encodeURIComponent(c.req.param('batchId'))}/cancel`, {
      method: 'POST',
      headers: vectorStoreReadHeaders
    }, config);
  });

  router.get('/v1/vector_stores/:vectorStoreId/file_batches/:batchId/files', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/vector_stores/${encodeURIComponent(c.req.param('vectorStoreId'))}/file_batches/${encodeURIComponent(c.req.param('batchId'))}/files${buildQueryString(new URL(c.req.url))}`, {
      method: 'GET',
      headers: vectorStoreReadHeaders
    }, config);
  });

  return router;
}
