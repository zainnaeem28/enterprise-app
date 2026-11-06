// Standard error body (ARCHITECTURE 28.4) and the registry codes this layer raises (30). Bodies carry codes and
// titles only: never a value from the request, never a database message.
import type { ApiErrorBody } from '@ehr/kernel';

const TITLES: Record<string, string> = {
  'kernel.client_release_unsupported': 'This version of the application is no longer supported',
  'kernel.validation_failed': 'The request is not valid',
  'kernel.rate_limited': 'Too many requests',
  'kernel.payload_too_large': 'The request is too large',
  'kernel.unavailable': 'The service is temporarily unavailable',
  'kernel.timeout': 'The request timed out',
  'kernel.not_found': 'Not found',
  'kernel.idempotency_conflict': 'The request conflicts with an earlier one',
  'kernel.precondition_failed': 'The resource has changed; reload and retry',
  'kernel.precondition_required': 'A precondition header is required',
  'kernel.internal': 'Unexpected error',
  'auth.unauthenticated': 'Sign-in required',
  'auth.forbidden': 'Forbidden',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly extras: {
      errors?: { path: string; code: string }[];
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export function problemBody(e: ApiError, requestId: string): ApiErrorBody {
  const body: ApiErrorBody & { retryAfterSeconds?: number } = {
    type: `https://errors.invalid/${e.code.replace('.', '/')}`,
    title: TITLES[e.code] ?? e.code,
    status: e.status,
    code: e.code,
    requestId,
    retryable: e.retryable,
  };
  if (e.extras.errors !== undefined) body.errors = e.extras.errors;
  if (e.extras.retryAfterSeconds !== undefined) body.retryAfterSeconds = e.extras.retryAfterSeconds;
  return body;
}
