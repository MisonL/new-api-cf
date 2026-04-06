import { execute, queryFirst } from './d1';

type RealtimeCallRegistryRow = {
  upstream_profile_id: string;
};

function now(): string {
  return new Date().toISOString();
}

export async function getRealtimeCallUpstreamProfileId(env: Env, callId: string): Promise<string | null> {
  if (!env.DB) {
    return null;
  }

  const row = await queryFirst<RealtimeCallRegistryRow>(
    env,
    'SELECT upstream_profile_id FROM relay_realtime_calls WHERE call_id = ?',
    callId
  );

  return row?.upstream_profile_id || null;
}

export async function upsertRealtimeCallRegistry(
  env: Env,
  input: {
    callId: string;
    upstreamProfileId: string;
  }
) {
  if (!env.DB) {
    return;
  }

  const timestamp = now();
  await execute(
    env,
    `INSERT INTO relay_realtime_calls (call_id, upstream_profile_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(call_id) DO UPDATE SET
       upstream_profile_id = excluded.upstream_profile_id,
       updated_at = excluded.updated_at`,
    input.callId,
    input.upstreamProfileId,
    timestamp,
    timestamp
  );
}

export async function deleteRealtimeCallRegistry(env: Env, callId: string) {
  if (!env.DB) {
    return;
  }

  await execute(
    env,
    'DELETE FROM relay_realtime_calls WHERE call_id = ?',
    callId
  );
}
