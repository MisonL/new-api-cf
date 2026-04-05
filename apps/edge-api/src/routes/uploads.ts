import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const createUploadRequestSchema = z.object({
  bytes: z.number().int().positive(),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  purpose: z.string().min(1),
  expires_after: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const completeUploadRequestSchema = z.object({
  part_ids: z.array(z.string().min(1)).min(1),
  md5: z.string().min(1).optional()
}).passthrough();

export function createUploadsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/uploads', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createUploadRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/uploads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.post('/v1/uploads/:uploadId/parts', async (c) => {
    const formData = await c.req.formData().catch(() => {
      throw new ApiError(400, 'INVALID_FORM_DATA', 'request body must be valid form data');
    });
    const data = formData.get('data');
    if (data === null || (typeof data === 'string' && !data.trim())) {
      throw new ApiError(400, 'INVALID_UPLOAD_PART', 'data field is required');
    }

    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/uploads/${encodeURIComponent(c.req.param('uploadId'))}/parts`, {
      method: 'POST',
      body: formData
    }, config);
  });

  router.post('/v1/uploads/:uploadId/complete', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = completeUploadRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/uploads/${encodeURIComponent(c.req.param('uploadId'))}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.post('/v1/uploads/:uploadId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/uploads/${encodeURIComponent(c.req.param('uploadId'))}/cancel`, {
      method: 'POST'
    }, config);
  });

  return router;
}
