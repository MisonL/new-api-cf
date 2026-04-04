import type { Context } from 'hono';
import type { SessionInfo } from '../../../../packages/shared/src/contracts';
import { ApiError } from './errors';
import type { RuntimeConfig } from './config';
import { readSessionFromCookie } from './session';
import { readBearerToken } from './token-auth';

function getAnonymousSession(authMode: SessionInfo['authMode']): SessionInfo {
  return {
    authenticated: false,
    authMode
  };
}

export function isSecureCookieEnvironment(config: RuntimeConfig): boolean {
  return config.environment !== 'development';
}

export function tokensEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

function getBearerSession(c: Context, config: RuntimeConfig): SessionInfo {
  const token = readBearerToken(c.req.header('Authorization'));
  const isAuthenticated = Boolean(token && config.adminBearerToken && token === config.adminBearerToken);

  return {
    authenticated: isAuthenticated,
    authMode: 'bearer',
    userId: isAuthenticated ? 'admin' : undefined,
    role: isAuthenticated ? 'admin' : undefined
  };
}

export async function getSessionInfo(c: Context, config: RuntimeConfig): Promise<SessionInfo> {
  if (config.authMode === 'disabled') {
    return getAnonymousSession('disabled');
  }

  if (config.authMode === 'bearer') {
    return getBearerSession(c, config);
  }

  const session = await readSessionFromCookie(c.req.header('Cookie'), config.sessionSecret);
  return session || {
    authenticated: false,
    authMode: 'session'
  };
}

export async function requireAdmin(c: Context, config: RuntimeConfig) {
  const session = await getSessionInfo(c, config);
  if (!session.authenticated) {
    throw new ApiError(401, 'UNAUTHORIZED', 'missing or invalid admin credentials');
  }
  return session;
}

export async function getAdminSessionOrNull(c: Context, config: RuntimeConfig) {
  const session = await getSessionInfo(c, config);
  return session.authenticated ? session : null;
}

export function assertLoginEnabled(config: RuntimeConfig) {
  if (config.authMode !== 'session') {
    throw new ApiError(400, 'LOGIN_NOT_AVAILABLE', 'login endpoint requires AUTH_MODE=session');
  }

  if (!config.adminBearerToken) {
    throw new ApiError(503, 'ADMIN_TOKEN_MISSING', 'ADMIN_BEARER_TOKEN is not configured');
  }

  if (!config.sessionSecret) {
    throw new ApiError(503, 'SESSION_SECRET_MISSING', 'SESSION_SECRET is not configured');
  }
}
