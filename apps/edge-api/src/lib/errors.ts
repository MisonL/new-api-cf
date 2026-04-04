import type { ApiErrorPayload } from '../../../../packages/shared/src/contracts';

export type ApiStatusCode =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 422
  | 429
  | 502
  | 500
  | 501
  | 503
  | 504;

export class ApiError extends Error {
  readonly status: ApiStatusCode;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: ApiStatusCode,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function toErrorPayload(error: ApiError): ApiErrorPayload {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    }
  };
}
