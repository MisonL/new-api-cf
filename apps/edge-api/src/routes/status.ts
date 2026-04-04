import { Hono } from 'hono';
import { getRuntimeConfig, isUpstreamConfigured } from '../lib/config';
import { ok } from '../lib/http';

export function createStatusRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/status', (c) => {
    const config = getRuntimeConfig(c.env);

    return ok(c, {
      runtime: 'cloudflare-workers',
      appName: config.appName,
      environment: config.environment,
      mode: 'worker-first-skeleton',
      authMode: config.authMode,
      upstreamConfigured: isUpstreamConfigured(config)
    });
  });

  return router;
}

