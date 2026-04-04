import { ApiError } from './errors';

function requireDatabase(env: Env): D1Database {
  if (!('DB' in env) || !env.DB) {
    throw new ApiError(503, 'D1_NOT_CONFIGURED', 'D1 binding is not configured');
  }

  return env.DB;
}

export function getDatabase(env: Env): D1Database {
  return requireDatabase(env);
}

export async function queryAll<T>(env: Env, sql: string, ...bindings: unknown[]): Promise<T[]> {
  const database = requireDatabase(env);
  const result = await database.prepare(sql).bind(...bindings).all<T>();
  return result.results;
}

export async function queryFirst<T>(env: Env, sql: string, ...bindings: unknown[]): Promise<T | null> {
  const database = requireDatabase(env);
  return database.prepare(sql).bind(...bindings).first<T>();
}

export async function execute(env: Env, sql: string, ...bindings: unknown[]) {
  const database = requireDatabase(env);
  return database.prepare(sql).bind(...bindings).run();
}

