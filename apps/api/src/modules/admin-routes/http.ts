// Shared request parsing and error translation of the BE-24 admin routes (ARCHITECTURE 28.4, 29.4, 30, 31.1). A body is an exact
// object: an unknown field, a wrong type or an out-of-range value is `400 kernel.validation_failed` with `errors[]` naming the
// field path and a registry-style code, never the value that was sent (secret values travel in these bodies).
import { ApiError } from '../../platform/errors.js';
import type { Req } from '../../platform/http.js';
import { AuditEnvelopeError, AuditError } from '../audit/index.js';
import { IntegrationError, IntegrationValidationError } from '../integration-core/index.js';

export interface FieldError {
  path: string;
  code: string;
}

export interface Meta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export const metaOf = (req: Req): Meta => ({
  requestId: req.requestId ?? '',
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

export const invalid = (errors: FieldError[]): ApiError =>
  new ApiError(400, 'kernel.validation_failed', false, { errors });
export const notFound = (): ApiError => new ApiError(404, 'kernel.not_found');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** The body as an exact object whose keys are within `allowed`. */
export function exactBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw invalid([{ path: '/', code: 'kernel.invalid_type' }]);
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0)
    throw invalid(extra.map((k) => ({ path: `/${k}`, code: 'kernel.unknown_field' })));
  return o;
}

export function pathUuid(v: unknown, name = 'id'): string {
  if (!isUuid(v)) throw notFound(); // a malformed id names nothing visible
  void name;
  return v;
}

export function optUuid(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!isUuid(v)) throw invalid([{ path: `/${k}`, code: 'kernel.invalid_format' }]);
  return v;
}

/** A date-time string with an explicit offset, as a Date. */
export function reqInstant(o: Record<string, unknown>, k: string): Date {
  const v = o[k];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v))
    throw invalid([{ path: `/${k}`, code: k in o ? 'kernel.invalid_format' : 'kernel.required' }]);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid([{ path: `/${k}`, code: 'kernel.invalid_format' }]);
  return d;
}

export function optString(
  o: Record<string, unknown>,
  k: string,
  max: number,
  min = 1,
): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim().length < min || v.length > max)
    throw invalid([{ path: `/${k}`, code: 'kernel.invalid_format' }]);
  return v;
}

export function reqString(o: Record<string, unknown>, k: string, max: number, min = 1): string {
  const v = optString(o, k, max, min);
  if (v === undefined) throw invalid([{ path: `/${k}`, code: 'kernel.required' }]);
  return v;
}

export function optInt(
  o: Record<string, unknown>,
  k: string,
  min: number,
  max: number,
): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw invalid([{ path: `/${k}`, code: 'kernel.invalid_format' }]);
  return v;
}

/** `limit` 1..100 (default 25) and an opaque offset `cursor` (as the BE-23 lists). */
export function parsePage(q: Record<string, unknown>): { limit: number; offset: number } {
  const bad: FieldError[] = [];
  let limit = 25;
  let offset = 0;
  if (q['limit'] !== undefined) {
    const n =
      typeof q['limit'] === 'string' && /^\d{1,3}$/.test(q['limit']) ? Number(q['limit']) : 0;
    if (n < 1 || n > 100) bad.push({ path: '/limit', code: 'kernel.invalid_format' });
    else limit = n;
  }
  if (q['cursor'] !== undefined) {
    const c = q['cursor'];
    const m = typeof c === 'string' ? /^o(\d{1,9})$/.exec(c) : null;
    if (m === null) bad.push({ path: '/cursor', code: 'kernel.invalid_format' });
    else offset = Number(m[1]);
  }
  if (bad.length > 0) throw invalid(bad);
  return { limit, offset };
}
export const cursorFor = (offset: number): string => `o${offset}`;

/** `If-Match: W/"<rowVersion>"` (or the bare number). 428 when absent, 412 for a malformed value (never matches). */
export function ifMatchVersion(header: string | undefined): number {
  if (header === undefined || header.trim() === '')
    throw new ApiError(428, 'kernel.precondition_required');
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(header.trim());
  if (m === null) throw new ApiError(412, 'kernel.precondition_failed');
  return Number(m[1]);
}
export const etag = (version: number): string => `W/"${version}"`;

/** Domain failures -> the standard API errors. Codes and field paths only: no request value, no driver text. */
export function translate(e: unknown): unknown {
  if (e instanceof ApiError) return e;
  if (e instanceof AuditEnvelopeError)
    return invalid(e.fields.map((f) => ({ path: `/${f}`, code: 'kernel.invalid_format' })));
  if (e instanceof IntegrationValidationError)
    return invalid(e.fields.map((f) => ({ path: `/${f}`, code: 'kernel.invalid_format' })));
  if (e instanceof AuditError || e instanceof IntegrationError)
    return new ApiError(e.status, e.code, e.retryable);
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
    case '23514':
      return invalid([{ path: '/', code: 'kernel.invalid_format' }]);
    default:
      return e;
  }
}
