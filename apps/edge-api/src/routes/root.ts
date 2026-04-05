import { Hono } from 'hono';
import { ok } from '../lib/http';

export function createRootRouter() {
  const router = new Hono();

  router.get('/', (c) => {
    return ok(c, {
      name: 'new-api-cf',
      description: 'worker-first AI gateway skeleton',
      routes: [
        '/api/status',
        '/api/auth/session',
        '/api/auth/login',
        '/api/auth/logout',
        '/api/admin/state',
        '/api/admin/bootstrap',
        '/api/admin/settings',
        '/api/admin/tokens',
        '/api/admin/usage',
        '/api/me',
        '/api/models',
        '/v1/batches',
        '/v1/batches/:batchId',
        '/v1/batches/:batchId/cancel',
        '/v1/files',
        '/v1/files/:fileId',
        '/v1/files/:fileId/content',
        '/v1/models',
        '/v1/audio/speech',
        '/v1/audio/transcriptions',
        '/v1/audio/translations',
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/embeddings',
        '/v1/images/edits',
        '/v1/images/generations',
        '/v1/images/variations',
        '/v1/moderations',
        '/v1/responses'
      ]
    });
  });

  return router;
}
