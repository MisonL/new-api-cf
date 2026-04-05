import { Hono } from 'hono';
import { ZodError } from 'zod';
import { createAuthRouter } from './routes/auth';
import { createAdminRouter } from './routes/admin';
import { createAudioRouter } from './routes/audio';
import { createChatRouter } from './routes/chat';
import { createCompletionsRouter } from './routes/completions';
import { createEmbeddingsRouter } from './routes/embeddings';
import { createFilesRouter } from './routes/files';
import { createImagesRouter } from './routes/images';
import { createModelRouter } from './routes/models';
import { createModerationsRouter } from './routes/moderations';
import { createResponsesRouter } from './routes/responses';
import { createRootRouter } from './routes/root';
import { createStatusRouter } from './routes/status';
import { corsMiddleware } from './lib/cors';
import { requestIdMiddleware } from './lib/request-id';
import { ApiError } from './lib/errors';
import { fail } from './lib/http';
import type { AppEnv } from './lib/types';
import { RelayRateLimiterDO } from './lib/relay-rate-limit';
import { consumeUsageQueue } from './lib/usage-queue';

const app = new Hono<AppEnv>();

app.use('*', corsMiddleware);
app.use('*', requestIdMiddleware);

app.route('/', createRootRouter());
app.route('/', createStatusRouter());
app.route('/', createAuthRouter());
app.route('/', createAdminRouter());
app.route('/', createModelRouter());
app.route('/', createFilesRouter());
app.route('/', createAudioRouter());
app.route('/', createChatRouter());
app.route('/', createCompletionsRouter());
app.route('/', createEmbeddingsRouter());
app.route('/', createImagesRouter());
app.route('/', createModerationsRouter());
app.route('/', createResponsesRouter());

app.onError((cause, c) => {
  if (cause instanceof ApiError) {
    return fail(c, cause);
  }

  if (cause instanceof ZodError) {
    return fail(c, new ApiError(400, 'VALIDATION_ERROR', 'request validation failed', {
      issues: cause.issues
    }));
  }

  console.error(
    JSON.stringify({
      level: 'error',
      message: 'unhandled worker exception',
      requestId: c.get('requestId'),
      error: cause instanceof Error ? cause.message : String(cause)
    })
  );

  return fail(c, new ApiError(500, 'INTERNAL_ERROR', 'unexpected internal error'));
});

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch<unknown>, env: Env) => {
    await consumeUsageQueue(batch, env);
  }
};

export { RelayRateLimiterDO };
