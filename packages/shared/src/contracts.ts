export type DeploymentTier = 'free' | 'paid';

export type CloudflareResourceKind =
  | 'pages'
  | 'workers'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'durable-object'
  | 'queue'
  | 'external-db'
  | 'external-cache';

export interface ResourceDecision {
  kind: CloudflareResourceKind;
  allowedOnFree: boolean;
  reason: string;
}

export interface ApiErrorPayload {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ApiSuccessPayload<T> {
  success: true;
  data: T;
}

export interface SessionInfo {
  authenticated: boolean;
  authMode: 'disabled' | 'bearer';
  userId?: string;
  role?: 'admin';
}

export interface ModelDescriptor {
  id: string;
  provider: 'openai-compatible';
  object: 'model';
  ownedBy: string;
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
}

export interface ChatCompletionRequestShape {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

