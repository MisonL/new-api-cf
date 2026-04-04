import type {
  AdminStateShape,
  ControlSettingValues,
  ModelDescriptor,
  StateStoreKind
} from '../../../../packages/shared/src/contracts';
import { execute, queryAll, queryFirst } from './d1';
import { ApiError } from './errors';
import type { RuntimeConfig } from './config';

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
