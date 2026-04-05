import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createFilesRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/v1/files', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/files${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.post('/v1/files', async (c) => {
    const formData = await c.req.formData().catch(() => {
      throw new ApiError(400, 'INVALID_FORM_DATA', 'request body must be valid form data');
    });
    if (!(formData.get('file') instanceof File)) {
      throw new ApiError(400, 'INVALID_FILE_UPLOAD', 'file field is required');
    }
    if (!String(formData.get('purpose') || '').trim()) {
      throw new ApiError(400, 'INVALID_FILE_PURPOSE', 'purpose field is required');
    }

    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/files', { method: 'POST', body: formData }, config);
  });

  router.get('/v1/files/:fileId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/files/${encodeURIComponent(c.req.param('fileId'))}`, { method: 'GET' }, config);
  });

  router.get('/v1/files/:fileId/content', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/files/${encodeURIComponent(c.req.param('fileId'))}/content`, { method: 'GET' }, config);
  });

  router.delete('/v1/files/:fileId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/files/${encodeURIComponent(c.req.param('fileId'))}`, { method: 'DELETE' }, config);
  });

  return router;
}
