import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { assertLoginEnabled, getSessionInfo, isSecureCookieEnvironment, requireAdmin, tokensEqual } from '../lib/auth';
import { ok } from '../lib/http';
import { ApiError } from '../lib/errors';
import { createLogoutCookie, createSessionCookie } from '../lib/session';
import { loginRequestSchema } from '../schemas/auth';

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/auth/session', async (c) => {
    const config = getRuntimeConfig(c.env);
    return ok(c, await getSessionInfo(c, config));
  });

  router.post('/api/auth/login', async (c) => {
    const config = getRuntimeConfig(c.env);
    assertLoginEnabled(config);

    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const request = loginRequestSchema.parse(payload);

    if (!tokensEqual(request.token, config.adminBearerToken!)) {
      throw new ApiError(401, 'INVALID_LOGIN_TOKEN', 'login token is invalid');
    }

    c.header('Set-Cookie', await createSessionCookie(config.sessionSecret!, isSecureCookieEnvironment(config)));
    return ok(c, {
      authenticated: true,
      authMode: 'session',
      userId: 'admin',
      role: 'admin'
    });
  });

  router.post('/api/auth/logout', (c) => {
    const config = getRuntimeConfig(c.env);
    c.header('Set-Cookie', createLogoutCookie(isSecureCookieEnvironment(config)));
    return ok(c, {
      authenticated: false
    });
  });

  router.get('/api/me', async (c) => {
    const config = getRuntimeConfig(c.env);
    const session = await requireAdmin(c, config);
    return ok(c, session);
  });

  return router;
}
