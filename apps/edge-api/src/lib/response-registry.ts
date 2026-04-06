import { execute, queryFirst } from './d1';

type ResponseRegistryRow = {
  upstream_profile_id: string;
};

function now(): string {
  return new Date().toISOString();
}

export async function getResponseUpstreamProfileId(env: Env, responseId: string): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  const row = await queryFirst<ResponseRegistryRow>(
    env,
    'SELECT upstream_profile_id FROM relay_responses WHERE response_id = ?',
    responseId
  );

  return row?.upstream_profile_id || null;
}

export async function upsertResponseRegistry(
  env: Env,
  input: {
    responseId: string;
    upstreamProfileId: string;
    model?: string;
  }
) {
  if (!env.DB) {
    return;
  }

  const timestamp = now();
  await execute(
    env,
    `INSERT INTO relay_responses (response_id, upstream_profile_id, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(response_id) DO UPDATE SET
       upstream_profile_id = excluded.upstream_profile_id,
       model = excluded.model,
       updated_at = excluded.updated_at`,
    input.responseId,
    input.upstreamProfileId,
    input.model || '',
    timestamp,
    timestamp
  );
}

export async function deleteResponseRegistry(env: Env, responseId: string) {
  if (!env.DB) {
    return;
  }

  await execute(
    env,
    'DELETE FROM relay_responses WHERE response_id = ?',
    responseId
  );
}
