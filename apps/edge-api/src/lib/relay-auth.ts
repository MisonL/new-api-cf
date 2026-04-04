import type { Context } from 'hono';
import type { RuntimeConfig } from './config';
import { getAdminSessionOrNull } from './auth';
import { verifyApiToken } from './control-plane';
import { requireBearerToken } from './token-auth';

export async function requireRelayAccess(c: Context, config: RuntimeConfig) {
  const adminSession = await getAdminSessionOrNull(c, config);
  if (adminSession) {
    return {
      kind: 'admin-session' as const
    };
  }

  const bearerToken = requireBearerToken(c.req.header('Authorization'));
  const apiToken = await verifyApiToken(c.env as Env, bearerToken);
  return {
    kind: 'api-token' as const,
    token: apiToken
  };
}
