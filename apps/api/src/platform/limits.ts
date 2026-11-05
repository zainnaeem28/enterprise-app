// Request limits (ARCHITECTURE 31.2) and validation helpers (31.1).
import { ApiError } from './errors.js';
import type { Next, Req, Res } from './http.js';
import { STREAM_PATH } from './client-release.js';
import { sendProblem } from './respond.js';

export const JSON_BODY_LIMIT = 1024 * 1024; // CN-12
export const SMALL_BODY_LIMIT = 256 * 1024; // note PATCH and webhook bodies
export const MAX_HEADER_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

/** Body limit by route class: note PATCH and webhook bodies are 256 KB, everything else 1 MB. */
export function bodyLimitFor(method: string, rawPath: string): number {
  const path = rawPath.toLowerCase();
  if (method === 'PATCH' && /^\/api\/v1\/notes\/[^/]+\/?$/.test(path)) return SMALL_BODY_LIMIT;
  if (path.startsWith('/webhooks/')) return SMALL_BODY_LIMIT;
  return JSON_BODY_LIMIT;
}

export function isStream(req: Req): boolean {
  return req.path.toLowerCase() === STREAM_PATH;
}

/** Sets the limit for this request and refuses a declared Content-Length above it before any byte is read. */
export function bodyLimitMiddleware(req: Req, res: Res, next: Next): void {
  req.bodyLimit = bodyLimitFor(req.method, req.path);
  const declared = Number(req.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > req.bodyLimit)
    return sendProblem(req, res, new ApiError(413, 'kernel.payload_too_large'));
  next();
}

/** `verify` hook for the JSON parser: also enforces the limit on chunked bodies. */
export function verifyBodySize(req: Req, _res: unknown, buf: Buffer): void {
  if (buf.length > (req.bodyLimit ?? JSON_BODY_LIMIT))
    throw new ApiError(413, 'kernel.payload_too_large');
}

/** Request timeout at the API (31.2). SSE streams are exempt. */
export function timeoutMiddleware(ms: number) {
  return (req: Req, res: Res, next: Next): void => {
    if (isStream(req)) return next();
    const timer = setTimeout(() => {
      sendProblem(req, res, new ApiError(504, 'kernel.timeout', true));
    }, ms);
    timer.unref();
    const clear = (): void => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

// ---- validation -----------------------------------------------------------------------------------------------

/** Control characters out, NFC form (31.1). Tab, LF and CR survive only when `multiline`. */
export function normaliseText(s: string, multiline = false): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0) as number;
    const isControl = c <= 0x1f || c === 0x7f;
    if (!isControl || (multiline && (c === 0x09 || c === 0x0a || c === 0x0d))) out += ch;
  }
  return out;
}

export type FieldSpec =
  | {
      type: 'string';
      max: number;
      min?: number;
      multiline?: boolean;
      pattern?: RegExp;
      optional?: boolean;
    }
  | { type: 'uuid'; optional?: boolean }
  | { type: 'integer'; min: number; max: number; optional?: boolean }
  | { type: 'enum'; values: readonly string[]; optional?: boolean }
  | { type: 'boolean'; optional?: boolean };

export type ObjectSchema = Record<string, FieldSpec>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate and normalise an object. Unknown fields are ignored on portal routes and refused on `integrations.`
 * (CN-12). Failures list paths and reason codes, never values (28.4).
 */
export function validateObject(
  input: unknown,
  schema: ObjectSchema,
  opts: { strict?: boolean } = {},
): Record<string, unknown> {
  const errors: { path: string; code: string }[] = [];
  const out: Record<string, unknown> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError(400, 'kernel.validation_failed', false, {
      errors: [{ path: '/', code: 'kernel.invalid_type' }],
    });
  }
  const obj = input as Record<string, unknown>;
  if (opts.strict === true) {
    for (const k of Object.keys(obj))
      if (!(k in schema)) errors.push({ path: `/${k}`, code: 'kernel.unknown_field' });
  }
  for (const [k, spec] of Object.entries(schema)) {
    const v = obj[k];
    const bad = (code: string): void => void errors.push({ path: `/${k}`, code });
    if (v === undefined || v === null) {
      if (spec.optional !== true) bad('kernel.required');
      continue;
    }
    switch (spec.type) {
      case 'string': {
        if (typeof v !== 'string') {
          bad('kernel.invalid_type');
          break;
        }
        const s = normaliseText(v, spec.multiline === true).trim();
        if (s.length < (spec.min ?? 0)) bad('kernel.too_short');
        else if (s.length > spec.max) bad('kernel.too_long');
        else if (spec.pattern !== undefined && !spec.pattern.test(s)) bad('kernel.invalid_format');
        else out[k] = s;
        break;
      }
      case 'uuid':
        if (typeof v === 'string' && UUID_RE.test(v)) out[k] = v.toLowerCase();
        else bad('kernel.invalid_format');
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) bad('kernel.invalid_type');
        else if (v < spec.min || v > spec.max) bad('kernel.out_of_range');
        else out[k] = v;
        break;
      case 'enum':
        if (typeof v === 'string' && spec.values.includes(v)) out[k] = v;
        else bad('kernel.invalid_value');
        break;
      case 'boolean':
        if (typeof v === 'boolean') out[k] = v;
        else bad('kernel.invalid_type');
        break;
    }
  }
  if (errors.length > 0) throw new ApiError(400, 'kernel.validation_failed', false, { errors });
  return out;
}
