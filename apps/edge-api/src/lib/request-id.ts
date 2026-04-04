import type { Context, Next } from 'hono';
import type { AppEnv } from './types';

const REQUEST_ID_HEADER = 'x-request-id';

export async function requestIdMiddleware(c: Context<AppEnv>, next: Next) {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  await next();
}
