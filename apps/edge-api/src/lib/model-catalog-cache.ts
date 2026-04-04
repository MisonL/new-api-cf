import type { ModelDescriptor } from '../../../../packages/shared/src/contracts';

const MODEL_CATALOG_CACHE_KEY = 'model-catalog:v1';
const MODEL_CATALOG_CACHE_TTL_SECONDS = 300;

type CacheEnv = Env & {
  MODEL_CATALOG_CACHE?: KVNamespace;
};

function getCache(env: Env): KVNamespace | null {
  return (env as CacheEnv).MODEL_CATALOG_CACHE ?? null;
}

export function isModelCatalogCacheConfigured(env: Env): boolean {
  return Boolean(getCache(env));
}

export async function readModelCatalogCache(env: Env): Promise<ModelDescriptor[] | null> {
  const cache = getCache(env);
  if (!cache) {
    return null;
  }

  const cached = await cache.get(MODEL_CATALOG_CACHE_KEY, 'json');
  if (!cached || !Array.isArray(cached)) {
    return null;
  }

  return cached as ModelDescriptor[];
}

export async function writeModelCatalogCache(env: Env, models: ModelDescriptor[]) {
  const cache = getCache(env);
  if (!cache) {
    return;
  }

  await cache.put(MODEL_CATALOG_CACHE_KEY, JSON.stringify(models), {
    expirationTtl: MODEL_CATALOG_CACHE_TTL_SECONDS
  });
}

export async function purgeModelCatalogCache(env: Env) {
  const cache = getCache(env);
  if (!cache) {
    return;
  }

  await cache.delete(MODEL_CATALOG_CACHE_KEY);
}
