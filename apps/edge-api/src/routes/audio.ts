import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { requireRelayAccess } from '../lib/relay-auth';
import { enforceRelayRateLimit } from '../lib/relay-rate-limit';
import { forwardSpeechCreate, forwardTranscriptionCreate } from '../lib/upstream';
import { parseTranscriptionRequest, speechCreateRequestSchema } from '../schemas/audio';

export function createAudioRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/audio/speech', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = speechCreateRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardSpeechCreate(c.env, request, config, access);
  });

  router.post('/v1/audio/transcriptions', async (c) => {
    const formData = await c.req.formData().catch(() => {
      throw new ApiError(400, 'INVALID_FORM_DATA', 'request body must be valid form data');
    });
    const request = parseTranscriptionRequest(formData);
    const config = getRuntimeConfig(c.env);
    const access = await requireRelayAccess(c, config);
    await enforceRelayRateLimit(c.env, access, config.relayRateLimitPerMinute);
    return forwardTranscriptionCreate(c.env, request.model, formData, config, access);
  });

  return router;
}
