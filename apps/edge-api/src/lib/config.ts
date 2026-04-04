import { z } from 'zod';
import type { AuthMode, UpstreamProfileDescriptor } from '../../../../packages/shared/src/contracts';

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
  OPENAI_PROVIDER_NAME: z.string().optional(),
  UPSTREAM_PROFILES_JSON: z.string().optional(),
  UPSTREAM_DEFAULT_PROFILE_ID: z.string().min(1).optional()
});

const upstreamProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  providerName: z.string().min(1).optional(),
  modelAllowlist: z.array(z.string().min(1)).default([])
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
  upstreamProfiles: Array<{
    id: string;
    label: string;
    baseUrl: string;
    apiKey: string;
    providerName: string;
    modelAllowlist: string[];
  }>;
  defaultUpstreamProfileId?: string;
};

function parseUpstreamProfiles(rawValue: string | undefined): RuntimeConfig['upstreamProfiles'] {
  if (!rawValue) {
    return [];
  }

  const parsed = JSON.parse(rawValue) as unknown;
  const profiles = z.array(upstreamProfileSchema).parse(parsed);
  return profiles.map((profile) => ({
    id: profile.id,
    label: profile.label || profile.id,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    providerName: profile.providerName || profile.id,
    modelAllowlist: profile.modelAllowlist
  }));
}

function getLegacyProfile(parsed: z.infer<typeof envSchema>): RuntimeConfig['upstreamProfiles'] {
  if (!parsed.OPENAI_BASE_URL || !parsed.OPENAI_API_KEY) {
    return [];
  }

  return [
    {
      id: 'default',
      label: parsed.OPENAI_PROVIDER_NAME || 'default',
      baseUrl: parsed.OPENAI_BASE_URL,
      apiKey: parsed.OPENAI_API_KEY,
      providerName: parsed.OPENAI_PROVIDER_NAME || 'openai-compatible',
      modelAllowlist: parseCsvList(parsed.OPENAI_MODEL_ALLOWLIST)
    }
  ];
}

function collectModelAllowlist(profiles: RuntimeConfig['upstreamProfiles']): string[] {
  return Array.from(
    new Set(
      profiles.flatMap((profile) => profile.modelAllowlist)
    )
  );
}

function resolveDefaultProfileId(
  profiles: RuntimeConfig['upstreamProfiles'],
  explicitProfileId: string | undefined
): string | undefined {
  if (explicitProfileId && profiles.some((profile) => profile.id === explicitProfileId)) {
    return explicitProfileId;
  }

  return profiles[0]?.id;
}

export function getUpstreamProfiles(config: RuntimeConfig): UpstreamProfileDescriptor[] {
  return config.upstreamProfiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    providerName: profile.providerName,
    modelCount: profile.modelAllowlist.length,
    supportedModelIds: profile.modelAllowlist,
    assignedModelIds: [],
    enabledAssignedModelIds: [],
    isDefault: profile.id === config.defaultUpstreamProfileId
  }));
}

export function getUpstreamProfileById(config: RuntimeConfig, profileId: string | undefined) {
  const resolvedId = profileId || config.defaultUpstreamProfileId;
  if (!resolvedId) {
    return null;
  }

  return config.upstreamProfiles.find((profile) => profile.id === resolvedId) ?? null;
}

export function profileSupportsModel(
  config: RuntimeConfig,
  profileId: string | undefined,
  modelId: string
): boolean {
  const profile = getUpstreamProfileById(config, profileId);
  if (!profile) {
    return false;
  }

  return profile.modelAllowlist.includes(modelId);
}

export function getRuntimeConfig(env: unknown): RuntimeConfig {
  const parsed = envSchema.parse(env);
  const upstreamProfiles = parseUpstreamProfiles(parsed.UPSTREAM_PROFILES_JSON);
  const normalizedProfiles = upstreamProfiles.length > 0 ? upstreamProfiles : getLegacyProfile(parsed);
  const defaultUpstreamProfileId = resolveDefaultProfileId(normalizedProfiles, parsed.UPSTREAM_DEFAULT_PROFILE_ID);
  const modelAllowlist = collectModelAllowlist(normalizedProfiles);
  const defaultProfile = getUpstreamProfileById(
    {
      appName: '',
      environment: '',
      authMode: 'disabled',
      corsOrigins: [],
      upstreamTimeoutMs: 30000,
      upstreamProviderName: '',
      modelAllowlist,
      upstreamProfiles: normalizedProfiles,
      defaultUpstreamProfileId
    },
    defaultUpstreamProfileId
  );

  return {
    appName: parsed.APP_NAME || 'new-api-cf',
    environment: parsed.ENVIRONMENT || 'unknown',
    authMode: parsed.AUTH_MODE || 'disabled',
    adminBearerToken: parsed.ADMIN_BEARER_TOKEN,
    sessionSecret: parsed.SESSION_SECRET,
    corsOrigins: parseCsvList(parsed.CORS_ORIGIN),
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS ?? 30000,
    upstreamBaseUrl: defaultProfile?.baseUrl,
    upstreamApiKey: defaultProfile?.apiKey,
    upstreamProviderName: defaultProfile?.providerName || 'openai-compatible',
    modelAllowlist,
    upstreamProfiles: normalizedProfiles,
    defaultUpstreamProfileId
  };
}

export function isUpstreamConfigured(config: RuntimeConfig): boolean {
  return config.upstreamProfiles.length > 0;
}
