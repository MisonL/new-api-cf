import { Hono } from 'hono';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { deleteRealtimeCallRegistry, getRealtimeCallUpstreamProfileId, upsertRealtimeCallRegistry } from '../lib/realtime-call-registry';
import { forwardOpenAiModelUtilityRequest, forwardOpenAiProfileUtilityRequest, resolveUpstreamProfileIdForModel } from '../lib/upstream';

const realtimeSessionSchema = z.object({
  model: z.string().min(1)
}).passthrough();

const createRealtimeClientSecretRequestSchema = z.object({
  session: realtimeSessionSchema
}).passthrough();

const realtimeTranscriptionSessionSchema = z.object({
  input_audio_transcription: z.object({
    model: z.string().min(1)
  }).passthrough()
}).passthrough();

const realtimeCallReferSchema = z.object({
  target_uri: z.string().min(1)
}).passthrough();

const realtimeCallRejectSchema = z.object({
  status_code: z.number().int().positive().optional()
}).passthrough();

function parseRealtimeCallId(response: Response) {
  const location = response.headers.get('location');
  if (!location) {
    return null;
  }
  const segments = location.split('/').filter(Boolean);
  const callId = segments.at(-1);
  return callId || null;
}

async function requireRealtimeCallProfileId(env: Env, callId: string) {
  const upstreamProfileId = await getRealtimeCallUpstreamProfileId(env, callId);
  if (!upstreamProfileId) {
    throw new ApiError(503, 'REALTIME_CALL_PROFILE_UNKNOWN', 'realtime call does not have a known upstream profile', {
      callId
    });
  }
  return upstreamProfileId;
}

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
    const upstreamProfileId = await resolveUpstreamProfileIdForModel(c.env, session.model, config);
    const response = await forwardOpenAiProfileUtilityRequest('/realtime/calls', {
      method: 'POST',
      body: upstreamFormData
    }, config, upstreamProfileId);
    const callId = parseRealtimeCallId(response);
    if (response.ok && callId) {
      await upsertRealtimeCallRegistry(c.env, {
        callId,
        upstreamProfileId
      });
    }
    return response;
  });

  router.post('/v1/realtime/calls/:callId/accept', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = realtimeSessionSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const upstreamProfileId = await resolveUpstreamProfileIdForModel(c.env, request.model, config);
    const callId = c.req.param('callId');
    const response = await forwardOpenAiProfileUtilityRequest(`/realtime/calls/${encodeURIComponent(callId)}/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config, upstreamProfileId);
    if (response.ok) {
      await upsertRealtimeCallRegistry(c.env, {
        callId,
        upstreamProfileId
      });
    }
    return response;
  });

  router.post('/v1/realtime/calls/:callId/hangup', async (c) => {
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const callId = c.req.param('callId');
    const upstreamProfileId = await requireRealtimeCallProfileId(c.env, callId);
    const response = await forwardOpenAiProfileUtilityRequest(`/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: 'POST'
    }, config, upstreamProfileId);
    if (response.ok) {
      await deleteRealtimeCallRegistry(c.env, callId);
    }
    return response;
  });

  router.post('/v1/realtime/calls/:callId/refer', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = realtimeCallReferSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const callId = c.req.param('callId');
    const upstreamProfileId = await requireRealtimeCallProfileId(c.env, callId);
    return forwardOpenAiProfileUtilityRequest(`/realtime/calls/${encodeURIComponent(callId)}/refer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config, upstreamProfileId);
  });

  router.post('/v1/realtime/calls/:callId/reject', async (c) => {
    const payload = await c.req.json().catch(() => null);
    const request = realtimeCallRejectSchema.parse(payload || {});
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    const callId = c.req.param('callId');
    const upstreamProfileId = await requireRealtimeCallProfileId(c.env, callId);
    const response = await forwardOpenAiProfileUtilityRequest(`/realtime/calls/${encodeURIComponent(callId)}/reject`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config, upstreamProfileId);
    if (response.ok) {
      await deleteRealtimeCallRegistry(c.env, callId);
    }
    return response;
  });

  router.post('/v1/realtime/sessions', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = realtimeSessionSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(c.env, '/realtime/sessions', request.model, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, config);
  });

  router.post('/v1/realtime/transcription_sessions', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = realtimeTranscriptionSessionSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardOpenAiModelUtilityRequest(
      c.env,
      '/realtime/transcription_sessions',
      request.input_audio_transcription.model,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(request)
      },
      config
    );
  });

  return router;
}
