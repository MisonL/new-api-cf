import { z } from 'zod';
import type { AuthMode } from '../../../../packages/shared/src/contracts';

const envSchema = z.object({
  ENVIRONMENT: z.string().optional(),
  APP_NAME: z.string().optional(),
  AUTH_MODE: z.enum(['disabled', 'bearer', 'session']).optional(),
  ADMIN_BEARER_TOKEN: z.string().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string().optional(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().max(120000).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL_ALLOWLIST: z.string().optional(),
  OPENAI_PROVIDER_NAME: z.string().optional()
});

function parseCsvList(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export type RuntimeConfig = {
  appName: string;
  environment: string;
  authMode: AuthMode;
  adminBearerToken?: string;
  sessionSecret?: string;
  corsOrigins: string[];
  upstreamTimeoutMs: number;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  upstreamProviderName: string;
  modelAllowlist: string[];
};

export function getRuntimeConfig(env: unknown): RuntimeConfig {
  const parsed = envSchema.parse(env);

  return {
    appName: parsed.APP_NAME || 'new-api-cf',
    environment: parsed.ENVIRONMENT || 'unknown',
    authMode: parsed.AUTH_MODE || 'disabled',
    adminBearerToken: parsed.ADMIN_BEARER_TOKEN,
    sessionSecret: parsed.SESSION_SECRET,
    corsOrigins: parseCsvList(parsed.CORS_ORIGIN),
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS ?? 30000,
    upstreamBaseUrl: parsed.OPENAI_BASE_URL,
    upstreamApiKey: parsed.OPENAI_API_KEY,
    upstreamProviderName: parsed.OPENAI_PROVIDER_NAME || 'openai-compatible',
    modelAllowlist: parseCsvList(parsed.OPENAI_MODEL_ALLOWLIST)
  };
}

export function isUpstreamConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.upstreamBaseUrl && config.upstreamApiKey && config.modelAllowlist.length > 0);
}
