import type { Context } from 'hono';
import { ApiError } from './errors';
import type { RuntimeConfig } from './config';

function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

export function getSessionInfo(c: Context, config: RuntimeConfig) {
  if (config.authMode === 'disabled') {
    return {
      authenticated: false,
      authMode: 'disabled' as const
    };
  }

  const token = readBearerToken(c.req.header('Authorization'));
  const isAuthenticated = Boolean(token && config.adminBearerToken && token === config.adminBearerToken);

  return {
    authenticated: isAuthenticated,
    authMode: 'bearer' as const,
    userId: isAuthenticated ? 'admin' : undefined,
    role: isAuthenticated ? ('admin' as const) : undefined
  };
}

export function requireAdmin(c: Context, config: RuntimeConfig) {
  const session = getSessionInfo(c, config);
  if (!session.authenticated) {
    throw new ApiError(401, 'UNAUTHORIZED', 'missing or invalid admin bearer token');
  }
  return session;
}

