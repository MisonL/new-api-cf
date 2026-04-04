import { Hono } from 'hono';
import { getRuntimeConfig } from '../lib/config';
import { bootstrapControlPlane, getAdminState, saveControlSettings, updateModel } from '../lib/control-plane';
import { requireAdmin } from '../lib/auth';
import { ok } from '../lib/http';
import { ApiError } from '../lib/errors';
import { controlSettingsSchema, updateModelSchema } from '../schemas/admin';

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

  return router;
}
