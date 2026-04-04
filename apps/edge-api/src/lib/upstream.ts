import type { ChatCompletionRequestShape, ModelDescriptor } from '../../../../packages/shared/src/contracts';
import type { RuntimeConfig } from './config';
import { ApiError } from './errors';

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
  return config.modelAllowlist.map((modelId) => ({
    id: modelId,
    provider: 'openai-compatible',
    object: 'model',
    ownedBy: config.upstreamProviderName
  }));
}

export function ensureUpstreamReady(config: RuntimeConfig) {
  if (!config.upstreamBaseUrl || !config.upstreamApiKey) {
    throw new ApiError(503, 'UPSTREAM_NOT_CONFIGURED', 'upstream base url or api key is missing');
  }

  if (config.modelAllowlist.length === 0) {
    throw new ApiError(503, 'MODEL_ALLOWLIST_EMPTY', 'OPENAI_MODEL_ALLOWLIST is empty');
  }
}

export function assertModelAllowed(model: string, config: RuntimeConfig) {
  if (!config.modelAllowlist.includes(model)) {
    throw new ApiError(400, 'MODEL_NOT_ALLOWED', 'requested model is not allowed', {
      model
    });
  }
}

export async function forwardChatCompletion(
  request: ChatCompletionRequestShape,
  config: RuntimeConfig
): Promise<Response> {
  ensureUpstreamReady(config);
  assertModelAllowed(request.model, config);

  const baseUrl = normalizeBaseUrl(config.upstreamBaseUrl!);
  const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: getUpstreamHeaders(config.upstreamApiKey!),
    body: JSON.stringify(request)
  });

  const responseHeaders = new Headers();
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    responseHeaders.set('content-type', contentType);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}

