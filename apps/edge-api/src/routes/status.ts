import { Hono } from 'hono';
import { getRuntimeConfig, isUpstreamConfigured } from '../lib/config';
import { ok } from '../lib/http';
import { getEnabledModels } from '../lib/control-plane';
import { isModelCatalogCacheConfigured } from '../lib/model-catalog-cache';
import { isRelayLimiterConfigured } from '../lib/relay-rate-limit';
import { isUsageQueueConfigured } from '../lib/usage-queue';

export function createStatusRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/status', async (c) => {
    const config = getRuntimeConfig(c.env);
    const modelState = await getEnabledModels(c.env, config).catch(() => ({
      stateStore: c.env.DB ? 'd1' as const : 'env' as const,
      models: []
    }));

    return ok(c, {
      runtime: 'cloudflare-workers',
      appName: config.appName,
      environment: config.environment,
      mode: 'worker-first-skeleton',
      authMode: config.authMode,
      upstreamConfigured: isUpstreamConfigured(config),
      loginAvailable: config.authMode === 'session',
      corsEnabled: config.corsOrigins.length > 0,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      relayRateLimitPerMinute: config.relayRateLimitPerMinute ?? 0,
      stateStore: modelState.stateStore,
      modelCount: modelState.models.length,
      d1Configured: Boolean(c.env.DB),
      kvConfigured: isModelCatalogCacheConfigured(c.env),
      queueConfigured: isUsageQueueConfigured(c.env),
      durableObjectConfigured: isRelayLimiterConfigured(c.env),
      endpoints: {
        admin: ['/api/auth/session', '/api/auth/login', '/api/auth/logout', '/api/admin/state', '/api/admin/bootstrap', '/api/admin/settings', '/api/admin/tokens', '/api/admin/usage', '/api/me', '/api/models'],
        openaiCompatible: ['/v1/models', '/v1/audio/speech', '/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/images/generations', '/v1/moderations', '/v1/responses']
      }
    });
  });

  return router;
}
