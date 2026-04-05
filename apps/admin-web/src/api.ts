type ApiEnvelope<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export type StatusData = {
  runtime: string;
  appName: string;
  environment: string;
  mode: string;
  authMode: 'disabled' | 'bearer' | 'session' | 'jwt';
  upstreamConfigured: boolean;
  loginAvailable: boolean;
  corsEnabled: boolean;
  upstreamTimeoutMs: number;
  relayRateLimitPerMinute?: number;
  stateStore: 'env' | 'd1';
  modelCount: number;
  d1Configured: boolean;
  kvConfigured?: boolean;
  queueConfigured?: boolean;
  durableObjectConfigured?: boolean;
  endpoints: {
    admin: string[];
    openaiCompatible: string[];
  };
};

export type SessionData = {
  authenticated: boolean;
  authMode: 'disabled' | 'bearer' | 'session' | 'jwt';
  userId?: string;
  role?: 'admin';
};

export type ModelListData = {
  object: 'list';
  stateStore: 'env' | 'd1';
  data: Array<{
    id: string;
    provider: 'openai-compatible';
    object: 'model';
    ownedBy: string;
    label?: string;
    enabled?: boolean;
    upstreamProfileId?: string;
    upstreamProfileExists?: boolean;
    upstreamProfileSupportsModel?: boolean;
  }>;
};

export type AdminState = {
  stateStore: 'env' | 'd1';
  settings: {
    publicAppName: string;
    welcomeMessage: string;
    playgroundEnabled: boolean;
  };
  models: Array<{
    id: string;
    provider: 'openai-compatible';
    object: 'model';
    ownedBy: string;
    label?: string;
    enabled?: boolean;
    upstreamProfileId?: string;
    upstreamProfileExists?: boolean;
    upstreamProfileSupportsModel?: boolean;
  }>;
  profiles: Array<{
    id: string;
    label: string;
    providerName: string;
    modelCount: number;
    supportedModelIds: string[];
    assignedModelIds: string[];
    enabledAssignedModelIds: string[];
    isDefault: boolean;
  }>;
};

export type ApiTokenDescriptor = {
  id: string;
  name: string;
  last4: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApiTokenCreateResult = {
  token: string;
  descriptor: ApiTokenDescriptor;
};

export type UsageOverview = {
  windowDays: number;
  totals: {
    requestCount: number;
    successCount: number;
    errorCount: number;
    activeActorCount: number;
    activeModelCount: number;
  };
  rows: Array<{
    usageDate: string;
    actorKind: 'admin-session' | 'api-token';
    actorId: string;
    actorLabel: string;
    actorLast4?: string;
    upstreamProfileId: string;
    upstreamProfileLabel: string;
    model: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    lastStatus: number;
    updatedAt: string;
  }>;
};

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant' | 'system' | 'user' | 'tool';
      content: string;
    };
    finish_reason?: string | null;
  }>;
};

export type ResponseCreateResult = Record<string, unknown>;

export type EmbeddingsCreateResult = {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[] | string;
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

export type ModerationsCreateResult = {
  id?: string;
  model?: string;
  results: Array<Record<string, unknown>>;
};

const EDGE_API_BASE_URL = import.meta.env.VITE_EDGE_API_BASE_URL ?? '';
const ADMIN_JWT_STORAGE_KEY = 'new-api-cf.admin-jwt';

function readStoredAdminJwt(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const token = window.localStorage.getItem(ADMIN_JWT_STORAGE_KEY)?.trim();
  return token ? token : null;
}

export function storeAdminJwt(token: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = token.trim();
  if (!normalized) {
    window.localStorage.removeItem(ADMIN_JWT_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(ADMIN_JWT_STORAGE_KEY, normalized);
}

export function clearStoredAdminJwt() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(ADMIN_JWT_STORAGE_KEY);
}

export function getStoredAdminJwt() {
  return readStoredAdminJwt();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('authorization')) {
    const adminJwt = readStoredAdminJwt();
    if (adminJwt) {
      headers.set('authorization', `Bearer ${adminJwt}`);
    }
  }

  const response = await fetch(`${EDGE_API_BASE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers
  });

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.success) {
    const message = payload.success ? 'request failed' : payload.error.message;
    throw new Error(message);
  }

  return payload.data;
}

export function fetchStatus() {
  return request<StatusData>('/api/status', {
    method: 'GET'
  });
}

export function fetchSession() {
  return request<SessionData>('/api/auth/session', {
    method: 'GET'
  });
}

export function login(token: string) {
  return request<SessionData>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token })
  });
}

export function logout() {
  return request<{ authenticated: boolean }>('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function fetchModels() {
  return request<ModelListData>('/api/models', {
    method: 'GET'
  });
}

export function sendChatCompletion(input: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  bearerToken?: string;
}) {
  const messages = [];

  if (input.systemPrompt && input.systemPrompt.trim().length > 0) {
    messages.push({
      role: 'system' as const,
      content: input.systemPrompt.trim()
    });
  }

  messages.push({
    role: 'user' as const,
    content: input.prompt.trim()
  });

  const headers = new Headers();
  if (input.bearerToken && input.bearerToken.trim().length > 0) {
    headers.set('authorization', `Bearer ${input.bearerToken.trim()}`);
  }

  return request<ChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: input.model,
      messages
    })
  });
}

export function sendResponseCreate(input: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  bearerToken?: string;
}) {
  const headers = new Headers();
  if (input.bearerToken && input.bearerToken.trim().length > 0) {
    headers.set('authorization', `Bearer ${input.bearerToken.trim()}`);
  }

  return request<ResponseCreateResult>('/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: input.model,
      instructions: input.systemPrompt?.trim() || undefined,
      input: input.prompt.trim()
    })
  });
}

export function sendEmbeddingsCreate(input: {
  model: string;
  prompt: string;
  bearerToken?: string;
}) {
  const headers = new Headers();
  if (input.bearerToken && input.bearerToken.trim().length > 0) {
    headers.set('authorization', `Bearer ${input.bearerToken.trim()}`);
  }

  return request<EmbeddingsCreateResult>('/v1/embeddings', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: input.model,
      input: input.prompt.trim()
    })
  });
}

export function sendModerationsCreate(input: {
  model: string;
  prompt: string;
  bearerToken?: string;
}) {
  const headers = new Headers();
  if (input.bearerToken && input.bearerToken.trim().length > 0) {
    headers.set('authorization', `Bearer ${input.bearerToken.trim()}`);
  }

  return request<ModerationsCreateResult>('/v1/moderations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: input.model,
      input: input.prompt.trim()
    })
  });
}

export function fetchAdminState() {
  return request<AdminState>('/api/admin/state', {
    method: 'GET'
  });
}

export function bootstrapAdminState() {
  return request<AdminState>('/api/admin/bootstrap', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export function saveAdminSettings(settings: AdminState['settings']) {
  return request<{ saved: boolean }>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(settings)
  });
}

export function updateAdminModel(modelId: string, input: { label: string; enabled: boolean; upstreamProfileId: string }) {
  return request<{ saved: boolean }>(`/api/admin/models/${encodeURIComponent(modelId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function fetchAdminTokens() {
  return request<{ data: ApiTokenDescriptor[] }>('/api/admin/tokens', {
    method: 'GET'
  });
}

export function fetchAdminUsage(days = 7) {
  return request<UsageOverview>(`/api/admin/usage?days=${encodeURIComponent(String(days))}`, {
    method: 'GET'
  });
}

export function createAdminToken(name: string) {
  return request<ApiTokenCreateResult>('/api/admin/tokens', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export function updateAdminToken(tokenId: string, input: { name: string; enabled: boolean }) {
  return request<{ saved: boolean }>(`/api/admin/tokens/${encodeURIComponent(tokenId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function deleteAdminToken(tokenId: string) {
  return request<{ deleted: boolean }>(`/api/admin/tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE'
  });
}
