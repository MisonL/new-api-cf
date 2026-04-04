import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import {
  bootstrapControlPlane,
  createApiToken,
  deleteApiToken,
  getAdminState,
  listApiTokens,
  saveControlSettings,
  updateApiToken,
  updateModel
} from '../lib/control-plane';
import { requireAdmin } from '../lib/auth';
import { ok } from '../lib/http';
import { ApiError } from '../lib/errors';
import { controlSettingsSchema, updateModelSchema } from '../schemas/admin';
import { createTokenSchema, updateTokenSchema } from '../schemas/token';

export function createAdminRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/api/admin/state', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    return ok(c, await getAdminState(c.env, config));
  });

  router.post('/api/admin/bootstrap', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    return ok(c, await bootstrapControlPlane(c.env, config));
  });

  router.put('/api/admin/settings', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const settings = controlSettingsSchema.parse(payload);
    await saveControlSettings(c.env, settings);
    return ok(c, {
      saved: true
    });
  });

  router.patch('/api/admin/models/:id', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const input = updateModelSchema.parse(payload);
    await updateModel(c.env, {
      id: c.req.param('id'),
      label: input.label,
      enabled: input.enabled
    });
    return ok(c, {
      saved: true
    });
  });

  router.get('/api/admin/tokens', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    return ok(c, {
      data: await listApiTokens(c.env)
    });
  });

  router.post('/api/admin/tokens', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const input = createTokenSchema.parse(payload);
    return ok(c, await createApiToken(c.env, input));
  });

  router.patch('/api/admin/tokens/:id', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    const payload = await c.req.json().catch(() => {
      throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON');
    });
    const input = updateTokenSchema.parse(payload);
    await updateApiToken(c.env, {
      id: c.req.param('id'),
      name: input.name,
      enabled: input.enabled
    });
    return ok(c, {
      saved: true
    });
  });

  router.delete('/api/admin/tokens/:id', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    await deleteApiToken(c.env, c.req.param('id'));
    return ok(c, {
      deleted: true
    });
  });

  return router;
}
