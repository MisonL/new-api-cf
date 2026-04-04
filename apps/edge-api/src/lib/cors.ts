import type { Context, Next } from 'hono';
import { getRuntimeConfig } from './config';
import type { AppEnv } from './types';

function isAllowedOrigin(requestOrigin: string, allowedOrigins: string[]) {
  return allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin);
}

function applyCorsHeaders(c: Context, requestOrigin: string) {
  c.header('Access-Control-Allow-Origin', requestOrigin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Vary', 'Origin');
}

export async function corsMiddleware(c: Context<AppEnv>, next: Next) {
  const requestOrigin = c.req.header('Origin');
  const config = getRuntimeConfig(c.env);

  if (requestOrigin && isAllowedOrigin(requestOrigin, config.corsOrigins)) {
    applyCorsHeaders(c, requestOrigin);
  }

  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: c.res.headers
    });
  }

  await next();
}
