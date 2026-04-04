import { Hono } from 'hono';
import { chatCompletionRequestSchema } from '../schemas/chat';
import { getRuntimeConfig } from '../lib/config';
import { forwardChatCompletion } from '../lib/upstream';
import { ApiError } from '../lib/errors';

export function createChatRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/v1/chat/completions', async (c) => {
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = chatCompletionRequestSchema.parse(payload);
    const config = getRuntimeConfig(c.env);
    return forwardChatCompletion(request, config);
  });

  return router;
}

