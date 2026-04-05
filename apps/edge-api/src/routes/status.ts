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
        openaiCompatible: ['/v1/batches', '/v1/batches/:batchId', '/v1/batches/:batchId/cancel', '/v1/files', '/v1/files/:fileId', '/v1/files/:fileId/content', '/v1/fine_tuning/jobs', '/v1/fine_tuning/jobs/:jobId', '/v1/fine_tuning/jobs/:jobId/cancel', '/v1/fine_tuning/jobs/:jobId/events', '/v1/fine_tuning/jobs/:jobId/checkpoints', '/v1/fine_tuning/checkpoints/:checkpointId/permissions', '/v1/fine_tuning/checkpoints/:checkpointId/permissions/:permissionId', '/v1/models', '/v1/vector_stores', '/v1/vector_stores/:vectorStoreId', '/v1/vector_stores/:vectorStoreId/search', '/v1/vector_stores/:vectorStoreId/files', '/v1/vector_stores/:vectorStoreId/files/:fileId', '/v1/vector_stores/:vectorStoreId/files/:fileId/content', '/v1/vector_stores/:vectorStoreId/file_batches', '/v1/vector_stores/:vectorStoreId/file_batches/:batchId', '/v1/vector_stores/:vectorStoreId/file_batches/:batchId/cancel', '/v1/vector_stores/:vectorStoreId/file_batches/:batchId/files', '/v1/audio/speech', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/chat/completions', '/v1/completions', '/v1/conversations', '/v1/conversations/:conversationId', '/v1/conversations/:conversationId/items', '/v1/conversations/:conversationId/items/:itemId', '/v1/embeddings', '/v1/images/edits', '/v1/images/generations', '/v1/images/variations', '/v1/moderations', '/v1/responses', '/v1/responses/input_tokens', '/v1/responses/compact', '/v1/responses/:responseId', '/v1/responses/:responseId/cancel', '/v1/responses/:responseId/input_items', '/v1/uploads', '/v1/uploads/:uploadId', '/v1/uploads/:uploadId/parts', '/v1/uploads/:uploadId/parts/:partId', '/v1/uploads/:uploadId/complete', '/v1/uploads/:uploadId/cancel', '/v1/realtime/client_secrets', '/v1/realtime/calls', '/v1/realtime/transcription_sessions']
      }
    });
  });

  return router;
}
