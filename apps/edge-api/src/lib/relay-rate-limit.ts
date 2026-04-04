import { ApiError } from './errors';
import type { RelayAccessContext } from './relay-auth';

type RateLimitCheckResult = {
  allowed: boolean;
  limit: number;
  count: number;
  remaining: number;
  resetAt: string;
};

type RateLimitRequest = {
  limit: number;
  bucket: string;
};

type RateLimiterEnv = Env & {
  RELAY_LIMITER?: DurableObjectNamespace;
};

function nowMinuteKey(): string {
  return new Date().toISOString().slice(0, 16);
}

function getResetAt(bucket: string): string {
  return `${bucket}:59.999Z`;
}

function getNamespace(env: Env): DurableObjectNamespace | null {
  return (env as RateLimiterEnv).RELAY_LIMITER ?? null;
}

export function isRelayLimiterConfigured(env: Env): boolean {
  return Boolean(getNamespace(env));
}

export function getRelayActorKey(access: RelayAccessContext): string {
  if (access.kind === 'api-token') {
    return `api-token:${access.token.id}`;
  }

  return `admin-session:${access.session.userId ?? 'admin'}`;
}

export class RelayRateLimiterDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const payload = (await request.json()) as RateLimitRequest;
    const bucket = payload.bucket;
    const limit = payload.limit;
    const stored = (await this.state.storage.get<{ bucket: string; count: number }>('window')) ?? {
      bucket,
      count: 0
    };

    const next = stored.bucket === bucket
      ? stored
      : {
          bucket,
          count: 0
        };

    if (next.count >= limit) {
      return Response.json({
        allowed: false,
        limit,
        count: next.count,
        remaining: 0,
        resetAt: getResetAt(bucket)
      } satisfies RateLimitCheckResult, { status: 429 });
    }

    next.count += 1;
    await this.state.storage.put('window', next);

    return Response.json({
      allowed: true,
      limit,
      count: next.count,
      remaining: Math.max(limit - next.count, 0),
      resetAt: getResetAt(bucket)
    } satisfies RateLimitCheckResult);
  }
}

export async function enforceRelayRateLimit(env: Env, access: RelayAccessContext, limit: number | undefined) {
  if (!limit) {
    return;
  }

  const namespace = getNamespace(env);
  if (!namespace) {
    throw new ApiError(503, 'RELAY_LIMITER_NOT_CONFIGURED', 'relay rate limiter Durable Object binding is missing');
  }

  const actorKey = getRelayActorKey(access);
  const stub = namespace.get(namespace.idFromName(actorKey));
  const response = await stub.fetch('https://relay-limiter.internal/check', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      limit,
      bucket: nowMinuteKey()
    } satisfies RateLimitRequest)
  });

  const payload = (await response.json()) as RateLimitCheckResult;
  if (!response.ok || !payload.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', 'relay rate limit exceeded', {
      limit: payload.limit,
      count: payload.count,
      remaining: payload.remaining,
      resetAt: payload.resetAt,
      actorKey
    });
  }
}
