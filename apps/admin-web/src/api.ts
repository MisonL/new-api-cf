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
  authMode: 'disabled' | 'bearer' | 'session';
  upstreamConfigured: boolean;
  loginAvailable: boolean;
  corsEnabled: boolean;
  upstreamTimeoutMs: number;
  endpoints: {
    admin: string[];
    openaiCompatible: string[];
  };
};

export type SessionData = {
  authenticated: boolean;
  authMode: 'disabled' | 'bearer' | 'session';
  userId?: string;
  role?: 'admin';
};

export type ModelListData = {
  object: 'list';
  data: Array<{
    id: string;
    provider: 'openai-compatible';
    object: 'model';
    ownedBy: string;
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

const EDGE_API_BASE_URL = import.meta.env.VITE_EDGE_API_BASE_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
    headers.set('content-type', 'application/json');
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

  return request<ChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: input.model,
      messages
    })
  });
}
