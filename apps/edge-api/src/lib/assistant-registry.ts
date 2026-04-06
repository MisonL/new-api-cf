import { execute, queryFirst } from './d1';

type AssistantRegistryRow = {
  upstream_profile_id: string;
};

function now(): string {
  return new Date().toISOString();
}

export async function getAssistantUpstreamProfileId(env: Env, assistantId: string): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  const row = await queryFirst<AssistantRegistryRow>(
    env,
    'SELECT upstream_profile_id FROM relay_assistants WHERE assistant_id = ?',
    assistantId
  );

  return row?.upstream_profile_id || null;
}

export async function upsertAssistantRegistry(
  env: Env,
  input: {
    assistantId: string;
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
    `INSERT INTO relay_assistants (assistant_id, upstream_profile_id, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(assistant_id) DO UPDATE SET
       upstream_profile_id = excluded.upstream_profile_id,
       model = excluded.model,
       updated_at = excluded.updated_at`,
    input.assistantId,
    input.upstreamProfileId,
    input.model || '',
    timestamp,
    timestamp
  );
}

export async function deleteAssistantRegistry(env: Env, assistantId: string) {
  if (!env.DB) {
    return;
  }

  await execute(
    env,
    'DELETE FROM relay_assistants WHERE assistant_id = ?',
    assistantId
  );
}
