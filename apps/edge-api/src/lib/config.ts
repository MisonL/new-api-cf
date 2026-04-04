import { z } from 'zod';

const envSchema = z.object({
  ENVIRONMENT: z.string().optional(),
  APP_NAME: z.string().optional(),
  AUTH_MODE: z.enum(['disabled', 'bearer']).optional(),
  ADMIN_BEARER_TOKEN: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL_ALLOWLIST: z.string().optional(),
  OPENAI_PROVIDER_NAME: z.string().optional()
});

function parseAllowlist(rawValue: string | undefined): string[] {
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
  authMode: 'disabled' | 'bearer';
  adminBearerToken?: string;
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
    upstreamBaseUrl: parsed.OPENAI_BASE_URL,
    upstreamApiKey: parsed.OPENAI_API_KEY,
    upstreamProviderName: parsed.OPENAI_PROVIDER_NAME || 'openai-compatible',
    modelAllowlist: parseAllowlist(parsed.OPENAI_MODEL_ALLOWLIST)
  };
}

export function isUpstreamConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.upstreamBaseUrl && config.upstreamApiKey && config.modelAllowlist.length > 0);
}
