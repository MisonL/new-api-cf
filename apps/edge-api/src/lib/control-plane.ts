import type {
  AdminStateShape,
  ApiTokenCreateResult,
  ApiTokenDescriptor,
  ControlSettingValues,
  ModelDescriptor,
  StateStoreKind,
  UpstreamProfileDescriptor
} from '../../../../packages/shared/src/contracts';
import { execute, queryAll, queryFirst } from './d1';
import { ApiError } from './errors';
import { getUpstreamProfileById, getUpstreamProfiles, profileSupportsModel, type RuntimeConfig } from './config';
import { purgeModelCatalogCache, readModelCatalogCache, writeModelCatalogCache } from './model-catalog-cache';
import { generateApiToken, hashApiToken, last4OfToken } from './token-auth';

const DEFAULT_SETTINGS: ControlSettingValues = {
  publicAppName: 'new-api-cf',
  welcomeMessage: 'Cloudflare Worker-first control plane',
  playgroundEnabled: true
};

type ModelRow = {
  id: string;
  provider: string;
  label: string;
  enabled: number;
  upstream_profile_id: string;
};

type SettingRow = {
  value_json: string;
};

type ApiTokenRow = {
  id: string;
  name: string;
  last4: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function fromEnvModels(config: RuntimeConfig): ModelDescriptor[] {
  const seen = new Set<string>();
  const models: ModelDescriptor[] = [];

  for (const profile of config.upstreamProfiles) {
    for (const id of profile.modelAllowlist) {
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      models.push({
        id,
        provider: 'openai-compatible',
        object: 'model',
        ownedBy: profile.providerName,
        label: id,
        enabled: true,
        upstreamProfileId: profile.id,
        upstreamProfileExists: true,
        upstreamProfileSupportsModel: true
      });
    }
  }

  return models;
}

function resolveModelProfileId(row: ModelRow, config: RuntimeConfig): string | undefined {
  return row.upstream_profile_id || config.defaultUpstreamProfileId;
}

function toModelDescriptor(row: ModelRow, config: RuntimeConfig): ModelDescriptor {
  const upstreamProfileId = resolveModelProfileId(row, config);
  const upstreamProfileExists = Boolean(getUpstreamProfileById(config, upstreamProfileId));
  const upstreamProfileSupportsModel = upstreamProfileExists
    ? profileSupportsModel(config, upstreamProfileId, row.id)
    : false;
  return {
    id: row.id,
    provider: 'openai-compatible',
    object: 'model',
    ownedBy: row.provider,
    label: row.label,
    enabled: row.enabled === 1,
    upstreamProfileId,
    upstreamProfileExists,
    upstreamProfileSupportsModel
  };
}

function toApiTokenDescriptor(row: ApiTokenRow): ApiTokenDescriptor {
  return {
    id: row.id,
    name: row.name,
    last4: row.last4,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function attachAssignedModels(
  profiles: UpstreamProfileDescriptor[],
  models: ModelDescriptor[]
): UpstreamProfileDescriptor[] {
  return profiles.map((profile) => {
    const assignedModels = models.filter((model) => model.upstreamProfileId === profile.id);
    return {
      ...profile,
      assignedModelIds: assignedModels.map((model) => model.id),
      enabledAssignedModelIds: assignedModels.filter((model) => model.enabled !== false).map((model) => model.id)
    };
  });
}

async function getAllModelsFromD1(env: Env, config: RuntimeConfig): Promise<ModelDescriptor[]> {
  const rows = await queryAll<ModelRow>(
    env,
    'SELECT id, provider, label, enabled, upstream_profile_id FROM relay_models ORDER BY id ASC'
  );

  return rows.map((row) => toModelDescriptor(row, config));
}

async function refreshEnabledModelCatalogCache(env: Env, config: RuntimeConfig) {
  if (!env.DB) {
    return;
  }

  const rows = await queryAll<ModelRow>(
    env,
    'SELECT id, provider, label, enabled, upstream_profile_id FROM relay_models WHERE enabled = 1 ORDER BY id ASC'
  );

  if (rows.length === 0) {
    await purgeModelCatalogCache(env);
    return;
  }

  await writeModelCatalogCache(
    env,
    rows.map((row) => toModelDescriptor(row, config))
  );
}

export async function getEnabledModels(env: Env, config: RuntimeConfig): Promise<{
  stateStore: StateStoreKind;
  models: ModelDescriptor[];
}> {
  if (!env.DB) {
    return {
      stateStore: 'env',
      models: fromEnvModels(config)
    };
  }

  const cachedModels = await readModelCatalogCache(env);
  if (cachedModels && cachedModels.length > 0) {
    return {
      stateStore: 'd1',
      models: cachedModels
    };
  }

  const rows = await queryAll<ModelRow>(
    env,
    'SELECT id, provider, label, enabled, upstream_profile_id FROM relay_models WHERE enabled = 1 ORDER BY id ASC'
  );

  if (rows.length === 0) {
    throw new ApiError(503, 'MODEL_CATALOG_EMPTY', 'D1 model catalog is empty');
  }

  const models = rows.map((row) => toModelDescriptor(row, config));
  await writeModelCatalogCache(env, models);

  return {
    stateStore: 'd1',
    models
  };
}

export async function getControlSettings(env: Env): Promise<ControlSettingValues> {
  const row = await queryFirst<SettingRow>(
    env,
    'SELECT value_json FROM control_settings WHERE key = ?',
    'app'
  );

  if (!row) {
    return DEFAULT_SETTINGS;
  }

  const parsed = JSON.parse(row.value_json) as Partial<ControlSettingValues>;
  return {
    ...DEFAULT_SETTINGS,
    ...parsed
  };
}

export async function saveControlSettings(env: Env, settings: ControlSettingValues) {
  const timestamp = now();
  await execute(
    env,
    `INSERT INTO control_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    'app',
    JSON.stringify(settings),
    timestamp
  );
}

export async function getAdminState(env: Env, config: RuntimeConfig): Promise<AdminStateShape> {
  if (!env.DB) {
    const envModels = fromEnvModels(config);
    return {
      stateStore: 'env',
      settings: DEFAULT_SETTINGS,
      models: envModels,
      profiles: attachAssignedModels(getUpstreamProfiles(config), envModels)
    };
  }

  const settings = await getControlSettings(env);
  const models = await getAllModelsFromD1(env, config);

  return {
    stateStore: 'd1',
    settings,
    models,
    profiles: attachAssignedModels(getUpstreamProfiles(config), models)
  };
}

export async function bootstrapControlPlane(env: Env, config: RuntimeConfig) {
  if (!env.DB) {
    throw new ApiError(503, 'D1_NOT_CONFIGURED', 'D1 binding is not configured');
  }

  const bootstrapModels = fromEnvModels(config);
  if (bootstrapModels.length === 0) {
    throw new ApiError(503, 'UPSTREAM_BOOTSTRAP_EMPTY', 'no upstream profile models are available for bootstrap');
  }

  const countRow = await queryFirst<{ count: number }>(
    env,
    'SELECT COUNT(*) AS count FROM relay_models'
  );

  if ((countRow?.count ?? 0) > 0) {
    throw new ApiError(409, 'CONTROL_PLANE_ALREADY_BOOTSTRAPPED', 'relay_models already contains rows');
  }

  const timestamp = now();
  for (const model of bootstrapModels) {
    await execute(
      env,
      `INSERT INTO relay_models (id, provider, label, enabled, upstream_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      model.id,
      model.ownedBy,
      model.label || model.id,
      model.upstreamProfileId || '',
      timestamp,
      timestamp
    );
  }

  await saveControlSettings(env, DEFAULT_SETTINGS);
  await writeModelCatalogCache(env, bootstrapModels);

  return getAdminState(env, config);
}

export async function updateModel(
  env: Env,
  config: RuntimeConfig,
  input: {
    id: string;
    label: string;
    enabled: boolean;
    provider: string;
    upstreamProfileId: string;
  }
) {
  const timestamp = now();
  const result = await execute(
    env,
    `UPDATE relay_models
     SET provider = ?, label = ?, enabled = ?, upstream_profile_id = ?, updated_at = ?
     WHERE id = ?`,
    input.provider,
    input.label,
    input.enabled ? 1 : 0,
    input.upstreamProfileId,
    timestamp,
    input.id
  );

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, 'MODEL_NOT_FOUND', 'model does not exist in D1 catalog', {
      model: input.id
    });
  }

  await refreshEnabledModelCatalogCache(env, config);
}

export async function listApiTokens(env: Env): Promise<ApiTokenDescriptor[]> {
  const rows = await queryAll<ApiTokenRow>(
    env,
    `SELECT id, name, last4, enabled, created_at, updated_at
     FROM api_tokens
     ORDER BY created_at DESC`
  );
  return rows.map(toApiTokenDescriptor);
}

export async function createApiToken(env: Env, input: { name: string }): Promise<ApiTokenCreateResult> {
  const token = generateApiToken();
  const tokenHash = await hashApiToken(token);
  const timestamp = now();
  const id = crypto.randomUUID();

  await execute(
    env,
    `INSERT INTO api_tokens (id, name, token_hash, last4, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    id,
    input.name,
    tokenHash,
    last4OfToken(token),
    timestamp,
    timestamp
  );

  return {
    token,
    descriptor: {
      id,
      name: input.name,
      last4: last4OfToken(token),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

export async function updateApiToken(
  env: Env,
  input: {
    id: string;
    name: string;
    enabled: boolean;
  }
) {
  const timestamp = now();
  const result = await execute(
    env,
    `UPDATE api_tokens
     SET name = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    input.name,
    input.enabled ? 1 : 0,
    timestamp,
    input.id
  );

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, 'TOKEN_NOT_FOUND', 'api token does not exist', {
      tokenId: input.id
    });
  }
}

export async function deleteApiToken(env: Env, tokenId: string) {
  const result = await execute(
    env,
    'DELETE FROM api_tokens WHERE id = ?',
    tokenId
  );

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, 'TOKEN_NOT_FOUND', 'api token does not exist', {
      tokenId
    });
  }
}

export async function verifyApiToken(env: Env, token: string): Promise<ApiTokenDescriptor> {
  if (!env.DB) {
    throw new ApiError(503, 'D1_NOT_CONFIGURED', 'D1 binding is not configured');
  }

  const tokenHash = await hashApiToken(token);
  const row = await queryFirst<ApiTokenRow>(
    env,
    `SELECT id, name, last4, enabled, created_at, updated_at
     FROM api_tokens
     WHERE token_hash = ?`,
    tokenHash
  );

  if (!row || row.enabled !== 1) {
    throw new ApiError(401, 'INVALID_API_TOKEN', 'api token is invalid or disabled');
  }

  return toApiTokenDescriptor(row);
}
