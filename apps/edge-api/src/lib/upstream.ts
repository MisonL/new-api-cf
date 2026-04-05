import type {
  ChatCompletionRequestShape,
  CompletionCreateRequestShape,
  EmbeddingsCreateRequestShape,
  ImageGenerationRequestShape,
  ModelDescriptor,
  ModerationsCreateRequestShape,
  ResponseCreateRequestShape,
  StateStoreKind
} from '../../../../packages/shared/src/contracts';
import { getUpstreamProfileById, profileSupportsModel, type RuntimeConfig } from './config';
import { ApiError } from './errors';
import { getEnabledModels } from './control-plane';
import type { RelayAccessContext } from './relay-auth';
import { dispatchUsageEvent } from './usage-queue';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function getUpstreamHeaders(apiKey: string) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`
  };
}

export function buildModelList(config: RuntimeConfig): ModelDescriptor[] {
  return config.upstreamProfiles.flatMap((profile) =>
    profile.modelAllowlist.map((modelId) => ({
      id: modelId,
      provider: 'openai-compatible' as const,
      object: 'model' as const,
      ownedBy: profile.providerName,
      label: modelId,
      upstreamProfileId: profile.id
    }))
  );
}

export function ensureUpstreamReady(config: RuntimeConfig) {
  if (config.upstreamProfiles.length === 0) {
    throw new ApiError(503, 'UPSTREAM_NOT_CONFIGURED', 'upstream profile is missing');
  }

  if (config.modelAllowlist.length === 0) {
    throw new ApiError(503, 'MODEL_ALLOWLIST_EMPTY', 'upstream profile model allowlists are empty');
  }
}

function assertModelAllowed(model: string, modelCatalog: ModelDescriptor[], stateStore: StateStoreKind) {
  if (!modelCatalog.some((item) => item.id === model)) {
    throw new ApiError(400, 'MODEL_NOT_ALLOWED', 'requested model is not allowed', {
      model,
      stateStore
    });
  }
}

export async function resolveModelCatalog(env: Env, config: RuntimeConfig): Promise<{
  stateStore: 'env' | 'd1';
  models: ModelDescriptor[];
}> {
  return getEnabledModels(env, config);
}

function resolveUpstreamProfile(config: RuntimeConfig, modelCatalog: ModelDescriptor[], model: string) {
  const descriptor = modelCatalog.find((item) => item.id === model);
  const profile = getUpstreamProfileById(config, descriptor?.upstreamProfileId);

  if (!profile) {
    throw new ApiError(503, 'UPSTREAM_PROFILE_NOT_FOUND', 'model does not have a usable upstream profile', {
      model,
      upstreamProfileId: descriptor?.upstreamProfileId
    });
  }

  if (!profileSupportsModel(config, profile.id, model)) {
    throw new ApiError(400, 'UPSTREAM_PROFILE_MODEL_MISMATCH', 'model is not declared by the selected upstream profile', {
      model,
      upstreamProfileId: profile.id
    });
  }

  return profile;
}

export async function forwardChatCompletion(
  env: Env,
  request: ChatCompletionRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/chat/completions', request.model, request, config, access);
}

export async function forwardResponseCreate(
  env: Env,
  request: ResponseCreateRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/responses', request.model, request, config, access);
}

export async function forwardEmbeddingsCreate(
  env: Env,
  request: EmbeddingsCreateRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/embeddings', request.model, request, config, access);
}

export async function forwardModerationsCreate(
  env: Env,
  request: ModerationsCreateRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/moderations', request.model, request, config, access);
}

export async function forwardCompletionCreate(
  env: Env,
  request: CompletionCreateRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/completions', request.model, request, config, access);
}

export async function forwardImageGeneration(
  env: Env,
  request: ImageGenerationRequestShape,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  return forwardOpenAiRequest(env, '/images/generations', request.model, request, config, access);
}

async function forwardOpenAiRequest(
  env: Env,
  upstreamPath: string,
  model: string,
  request: unknown,
  config: RuntimeConfig,
  access: RelayAccessContext
): Promise<Response> {
  ensureUpstreamReady(config);
  const catalog = await resolveModelCatalog(env, config);
  assertModelAllowed(model, catalog.models, catalog.stateStore);
  const profile = resolveUpstreamProfile(config, catalog.models, model);

  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs);
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(`${baseUrl}${upstreamPath}`, {
      method: 'POST',
      headers: getUpstreamHeaders(profile.apiKey),
      body: JSON.stringify(request),
      signal: abortController.signal
    });
  } catch (cause) {
    if (abortController.signal.aborted) {
      await dispatchUsageEvent(env, {
        actor: access.usageActor,
        upstreamProfileId: profile.id,
        model,
        outcome: 'error',
        statusCode: 504
      });
      throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'upstream request timed out', {
        timeoutMs: config.upstreamTimeoutMs
      });
    }

    await dispatchUsageEvent(env, {
      actor: access.usageActor,
      upstreamProfileId: profile.id,
      model,
      outcome: 'error',
      statusCode: 502
    });
    throw new ApiError(502, 'UPSTREAM_FETCH_FAILED', 'failed to reach upstream provider', {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  await dispatchUsageEvent(env, {
    actor: access.usageActor,
    upstreamProfileId: profile.id,
    model,
    outcome: upstreamResponse.ok ? 'success' : 'error',
    statusCode: upstreamResponse.status
  });

  const responseHeaders = new Headers();
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    responseHeaders.set('content-type', contentType);
  }
  const upstreamRequestId = upstreamResponse.headers.get('x-request-id');
  if (upstreamRequestId) {
    responseHeaders.set('x-upstream-request-id', upstreamRequestId);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}
