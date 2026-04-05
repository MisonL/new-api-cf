import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardOpenAiModelUtilityRequest } from '../lib/upstream';

const realtimeSessionSchema = z.object({
  model: z.string().min(1)
}).passthrough();

const createRealtimeClientSecretRequestSchema = z.object({
  session: realtimeSessionSchema
}).passthrough();

export function createRealtimeRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/realtime/client_secrets', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = createRealtimeClientSecretRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(c.env, '/realtime/client_secrets', request.session.model, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.post('/v1/realtime/calls', async (c) => {
    const formData = await c.req.formData().catch(() => {
      throw new ApiError(400, 'INVALID_FORM_DATA', 'request body must be valid form data');
    });

    const sdp = formData.get('sdp');
    if (typeof sdp !== 'string' || !sdp.trim()) {
      throw new ApiError(400, 'INVALID_REALTIME_SDP', 'sdp field is required');
    }

    const sessionRaw = formData.get('session');
    if (typeof sessionRaw !== 'string' || !sessionRaw.trim()) {
      throw new ApiError(400, 'INVALID_REALTIME_SESSION', 'session field is required');
    }

    const sessionPayload = JSON.parse(sessionRaw) as unknown;
    const session = realtimeSessionSchema.parse(sessionPayload);
    const upstreamFormData = new FormData();
    upstreamFormData.set('sdp', sdp);
    upstreamFormData.set('session', JSON.stringify(sessionPayload));

    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(c.env, '/realtime/calls', session.model, {
      method: 'POST',
      body: upstreamFormData
    }, config);
  });

  return router;
}
