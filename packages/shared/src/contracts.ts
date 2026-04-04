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

export type AuthMode = 'disabled' | 'bearer' | 'session';

export interface SessionInfo {
  authenticated: boolean;
  authMode: AuthMode;
  userId?: string;
  role?: 'admin';
}

export interface LoginRequestShape {
  token: string;
}

export interface ModelDescriptor {
  id: string;
  provider: 'openai-compatible';
  object: 'model';
  ownedBy: string;
  label?: string;
  enabled?: boolean;
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

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason?: string | null;
}

export interface ChatCompletionResponseShape {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
}

export type StateStoreKind = 'env' | 'd1';

export interface ControlSettingValues {
  publicAppName: string;
  welcomeMessage: string;
  playgroundEnabled: boolean;
}

export interface AdminStateShape {
  stateStore: StateStoreKind;
  settings: ControlSettingValues;
  models: ModelDescriptor[];
}
