import { Hono } from 'hono';
import { getRuntimeConfig, getUpstreamProfileById, profileSupportsModel } from '../lib/config';
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
import { getUsageOverview } from '../lib/usage';
import { controlSettingsSchema, updateModelSchema } from '../schemas/admin';
import { createTokenSchema, updateTokenSchema } from '../schemas/token';

function parseWindowDays(rawValue: string | undefined): number {
  if (!rawValue) {
    return 7;
  }

  const windowDays = Number(rawValue);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    throw new ApiError(400, 'INVALID_USAGE_WINDOW', 'usage days must be an integer between 1 and 30');
  }

  return windowDays;
}

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
    const upstreamProfile = getUpstreamProfileById(config, input.upstreamProfileId);
    if (!upstreamProfile) {
      throw new ApiError(400, 'INVALID_UPSTREAM_PROFILE', 'upstream profile does not exist', {
        upstreamProfileId: input.upstreamProfileId
      });
    }
    if (!profileSupportsModel(config, input.upstreamProfileId, c.req.param('id'))) {
      throw new ApiError(400, 'MODEL_PROFILE_MISMATCH', 'selected upstream profile does not declare this model', {
        model: c.req.param('id'),
        upstreamProfileId: input.upstreamProfileId
      });
    }
    await updateModel(c.env, config, {
      id: c.req.param('id'),
      label: input.label,
      enabled: input.enabled,
      provider: upstreamProfile.providerName,
      upstreamProfileId: input.upstreamProfileId
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

  router.get('/api/admin/usage', async (c) => {
    const config = getRuntimeConfig(c.env);
    await requireAdmin(c, config);
    const windowDays = parseWindowDays(c.req.query('days'));
    return ok(c, await getUsageOverview(c.env, config, windowDays));
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
