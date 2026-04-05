import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiUtilityRequest } from '../lib/upstream';

const createFineTuningJobRequestSchema = z.object({
  model: z.string().min(1),
  training_file: z.string().min(1),
  validation_file: z.string().min(1).optional(),
  suffix: z.string().min(1).optional(),
  method: z.record(z.string(), z.unknown()).optional(),
  hyperparameters: z.record(z.string(), z.unknown()).optional(),
  integrations: z.array(z.record(z.string(), z.unknown())).optional(),
  seed: z.number().int().optional(),
  metadata: z.record(z.string(), z.string()).optional()
});

const createCheckpointPermissionRequestSchema = z.object({}).passthrough();

function buildQueryString(url: URL) {
  return url.search ? url.search : '';
}

export function createFineTuningRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/v1/fine_tuning/jobs', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/jobs${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.post('/v1/fine_tuning/jobs', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createFineTuningJobRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest('/fine_tuning/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.get('/v1/fine_tuning/jobs/:jobId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/jobs/${encodeURIComponent(c.req.param('jobId'))}`, { method: 'GET' }, config);
  });

  router.post('/v1/fine_tuning/jobs/:jobId/cancel', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/jobs/${encodeURIComponent(c.req.param('jobId'))}/cancel`, { method: 'POST' }, config);
  });

  router.get('/v1/fine_tuning/jobs/:jobId/events', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/jobs/${encodeURIComponent(c.req.param('jobId'))}/events${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.get('/v1/fine_tuning/jobs/:jobId/checkpoints', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/jobs/${encodeURIComponent(c.req.param('jobId'))}/checkpoints${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.get('/v1/fine_tuning/checkpoints/:checkpointId/permissions', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/checkpoints/${encodeURIComponent(c.req.param('checkpointId'))}/permissions${buildQueryString(new URL(c.req.url))}`, { method: 'GET' }, config);
  });

  router.post('/v1/fine_tuning/checkpoints/:checkpointId/permissions', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createCheckpointPermissionRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/checkpoints/${encodeURIComponent(c.req.param('checkpointId'))}/permissions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.delete('/v1/fine_tuning/checkpoints/:checkpointId/permissions/:permissionId', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiUtilityRequest(`/fine_tuning/checkpoints/${encodeURIComponent(c.req.param('checkpointId'))}/permissions/${encodeURIComponent(c.req.param('permissionId'))}`, { method: 'DELETE' }, config);
  });

  return router;
}
