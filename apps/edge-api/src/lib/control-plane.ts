import type {
  AdminStateShape,
  ApiTokenCreateResult,
  ApiTokenDescriptor,
  ControlSettingValues,
  ModelDescriptor,
  StateStoreKind
} from '../../../../packages/shared/src/contracts';
import { execute, queryAll, queryFirst } from './d1';
import { ApiError } from './errors';
import type { RuntimeConfig } from './config';
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
  return config.modelAllowlist.map((id) => ({
    id,
    provider: 'openai-compatible',
    object: 'model',
    ownedBy: config.upstreamProviderName,
    label: id,
    enabled: true
  }));
}

function toModelDescriptor(row: ModelRow): ModelDescriptor {
  return {
    id: row.id,
    provider: 'openai-compatible',
    object: 'model',
    ownedBy: row.provider,
    label: row.label,
    enabled: row.enabled === 1
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

async function getAllModelsFromD1(env: Env): Promise<ModelDescriptor[]> {
  const rows = await queryAll<ModelRow>(
    env,
    'SELECT id, provider, label, enabled FROM relay_models ORDER BY id ASC'
  );

  return rows.map(toModelDescriptor);
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

  const rows = await queryAll<ModelRow>(
    env,
    'SELECT id, provider, label, enabled FROM relay_models WHERE enabled = 1 ORDER BY id ASC'
  );

  if (rows.length === 0) {
    throw new ApiError(503, 'MODEL_CATALOG_EMPTY', 'D1 model catalog is empty');
  }

  return {
    stateStore: 'd1',
    models: rows.map(toModelDescriptor)
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
    return {
      stateStore: 'env',
      settings: DEFAULT_SETTINGS,
      models: fromEnvModels(config)
    };
  }

  const settings = await getControlSettings(env);
  const models = await getAllModelsFromD1(env);

  return {
    stateStore: 'd1',
    settings,
    models
  };
}

export async function bootstrapControlPlane(env: Env, config: RuntimeConfig) {
  if (!env.DB) {
    throw new ApiError(503, 'D1_NOT_CONFIGURED', 'D1 binding is not configured');
  }

  const countRow = await queryFirst<{ count: number }>(
    env,
    'SELECT COUNT(*) AS count FROM relay_models'
  );

  if ((countRow?.count ?? 0) > 0) {
    throw new ApiError(409, 'CONTROL_PLANE_ALREADY_BOOTSTRAPPED', 'relay_models already contains rows');
  }

  const timestamp = now();
  for (const modelId of config.modelAllowlist) {
    await execute(
      env,
      `INSERT INTO relay_models (id, provider, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      modelId,
      config.upstreamProviderName,
      modelId,
      timestamp,
      timestamp
    );
  }

  await saveControlSettings(env, DEFAULT_SETTINGS);

  return getAdminState(env, config);
}

export async function updateModel(
  env: Env,
  input: {
    id: string;
    label: string;
    enabled: boolean;
  }
) {
  const timestamp = now();
  const result = await execute(
    env,
    `UPDATE relay_models
     SET label = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    input.label,
    input.enabled ? 1 : 0,
    timestamp,
    input.id
  );

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, 'MODEL_NOT_FOUND', 'model does not exist in D1 catalog', {
      model: input.id
    });
  }
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
