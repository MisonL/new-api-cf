import { Hono } from 'hono';
import { ZodError } from 'zod';
import { createAuthRouter } from './routes/auth';
import { createChatRouter } from './routes/chat';
import { createModelRouter } from './routes/models';
import { createRootRouter } from './routes/root';
import { createStatusRouter } from './routes/status';
import { corsMiddleware } from './lib/cors';
import { requestIdMiddleware } from './lib/request-id';
import { ApiError } from './lib/errors';
import { fail } from './lib/http';
import type { AppEnv } from './lib/types';

const app = new Hono<AppEnv>();

app.use('*', corsMiddleware);
app.use('*', requestIdMiddleware);

app.route('/', createRootRouter());
app.route('/', createStatusRouter());
app.route('/', createAuthRouter());
app.route('/', createModelRouter());
app.route('/', createChatRouter());

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

export default app;
