import { execute, queryFirst } from './d1';

type ThreadRegistryRow = {
  upstream_profile_id: string;
};

function now(): string {
  return new Date().toISOString();
}

export async function getThreadUpstreamProfileId(env: Env, threadId: string): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  const row = await queryFirst<ThreadRegistryRow>(
    env,
    'SELECT upstream_profile_id FROM relay_threads WHERE thread_id = ?',
    threadId
  );

  return row?.upstream_profile_id || null;
}

export async function upsertThreadRegistry(
  env: Env,
  input: {
    threadId: string;
    upstreamProfileId: string;
  }
) {
  if (!env.DB) {
    return;
  }

  const timestamp = now();
  await execute(
    env,
    `INSERT INTO relay_threads (thread_id, upstream_profile_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       upstream_profile_id = excluded.upstream_profile_id,
       updated_at = excluded.updated_at`,
    input.threadId,
    input.upstreamProfileId,
    timestamp,
    timestamp
  );
}

export async function deleteThreadRegistry(env: Env, threadId: string) {
  if (!env.DB) {
    return;
  }

  await execute(
    env,
    'DELETE FROM relay_threads WHERE thread_id = ?',
    threadId
  );
}
