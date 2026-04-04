import type { Context } from 'hono';
import type { ApiSuccessPayload } from '../../../../packages/shared/src/contracts';
import { ApiError, toErrorPayload } from './errors';

export function ok<T>(c: Context, data: T) {
  const payload: ApiSuccessPayload<T> = {
    success: true,
    data
  };

  return c.json(payload);
}

export function fail(c: Context, error: ApiError) {
  return c.json(toErrorPayload(error), error.status);
}
