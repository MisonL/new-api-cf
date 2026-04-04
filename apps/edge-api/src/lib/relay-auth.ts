import type { ApiTokenDescriptor, SessionInfo } from '../../../../packages/shared/src/contracts';
import type { Context } from 'hono';
import type { RuntimeConfig } from './config';
import { getAdminSessionOrNull } from './auth';
import { verifyApiToken } from './control-plane';
import { ApiError } from './errors';
import { readBearerToken } from './token-auth';
import type { UsageActor } from './usage';

export type RelayAccessContext =
  | {
      kind: 'admin-session';
      session: SessionInfo;
      usageActor: UsageActor;
    }
  | {
      kind: 'api-token';
      token: ApiTokenDescriptor;
      usageActor: UsageActor;
    };

export async function requireRelayAccess(c: Context, config: RuntimeConfig): Promise<RelayAccessContext> {
  const bearerToken = readBearerToken(c.req.header('Authorization'));
  const adminSession = await getAdminSessionOrNull(c, config);

  if (config.authMode === 'bearer' && adminSession) {
    return {
      kind: 'admin-session',
      session: adminSession,
      usageActor: {
        kind: 'admin-session',
        actorId: adminSession.userId ?? 'admin'
      }
    };
  }

  if (bearerToken) {
    const apiToken = await verifyApiToken(c.env as Env, bearerToken);
    return {
      kind: 'api-token',
      token: apiToken,
      usageActor: {
        kind: 'api-token',
        actorId: apiToken.id
      }
    };
  }

  if (adminSession) {
    return {
      kind: 'admin-session',
      session: adminSession,
      usageActor: {
        kind: 'admin-session',
        actorId: adminSession.userId ?? 'admin'
      }
    }
  }

  throw new ApiError(401, 'UNAUTHORIZED', 'missing relay credentials');
}
