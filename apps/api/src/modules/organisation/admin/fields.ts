// Field definitions and strict body parsing for the admin configuration routes (ARCHITECTURE 29.4). A body is an exact object:
// an unknown field, a wrong type or an out-of-range value is `400 kernel.validation_failed` with `errors[]` naming the field
// path and a registry-style code, never the value that was sent.
import { ApiError } from '../../../platform/errors.js';

export type Kind =
  | 'text'
  | 'int'
  | 'bool'
  | 'uuid'
  | 'enum'
  | 'date'
  | 'time'
  | 'ts'
  | 'json'
  | 'tz'
  | 'state'
  | 'currency';

export interface FieldDef {
  /** The API name (camelCase). */
  n: string;
  /** The column. */
  c: string;
  k: Kind;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** An explicit `null` is allowed and stored as NULL. */
  nullable?: boolean;
  /** Required on create. */
  req?: boolean;
  /** Set on create, never changed afterwards. */
  fixed?: boolean;
  /** A bigint column (read back as a number). */
  big?: boolean;
}

export interface FieldError {
  path: string;
  code: string;
}

export const invalid = (errors: FieldError[]): ApiError =>
  new ApiError(400, 'kernel.validation_failed', false, { errors });
export const invalidField = (path: string, code = 'kernel.invalid_format'): ApiError =>
  invalid([{ path: `/${path}`, code }]);
export const notFound = (): ApiError => new ApiError(404, 'kernel.not_found');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Control characters other than tab, line feed and carriage return. */
const hasControl = (v: string): boolean =>
  [...v].some((ch) => {
    const c = ch.codePointAt(0) as number;
    return (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
  });

export const isDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  DATE.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
export const isTime = (v: unknown): v is string => typeof v === 'string' && TIME.test(v);

function validZone(v: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Parses one value. Returns the normalised value, or `undefined` when it is not valid for the field. */
export function parseValue(f: FieldDef, v: unknown): unknown {
  switch (f.k) {
    case 'text': {
      if (typeof v !== 'string' || hasControl(v)) return undefined;
      const t = v.trim();
      return t.length >= (f.min ?? 1) && t.length <= (f.max ?? 200) ? t : undefined;
    }
    case 'int':
      return typeof v === 'number' &&
        Number.isInteger(v) &&
        v >= (f.min ?? 0) &&
        v <= (f.max ?? 1_000_000_000)
        ? v
        : undefined;
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'uuid':
      return isUuid(v) ? v : undefined;
    case 'enum':
      return typeof v === 'string' && (f.values ?? []).includes(v) ? v : undefined;
    case 'date':
      return isDate(v) ? v : undefined;
    case 'time':
      return isTime(v) ? v : undefined;
    case 'ts': {
      if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v))
        return undefined;
      const ms = Date.parse(v);
      return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
    }
    case 'json': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
      return JSON.stringify(v).length <= (f.max ?? 2048) ? v : undefined;
    }
    case 'tz':
      return typeof v === 'string' && v.length <= 64 && validZone(v) ? v : undefined;
    case 'state':
      return typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : undefined;
    case 'currency':
      return typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : undefined;
  }
}

/** The body must be a plain JSON object. */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalid([{ path: '/', code: 'kernel.invalid_format' }]);
  return body as Record<string, unknown>;
}

/** Rejects any key that is not in `allowed`. */
export function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): FieldError[] {
  return Object.keys(o)
    .filter((k) => !allowed.includes(k))
    .map((k) => ({
      path: `/${k.slice(0, 40).replace(/[^A-Za-z0-9_]/g, '_')}`,
      code: 'kernel.unknown_field',
    }));
}

/**
 * Parses the fields of `defs` present in `o`. On create every `req` field must be there; on patch a `fixed` field must not be.
 * `extra` names body keys the caller handles itself (`id`, `remove`...).
 */
export function parseFields(
  defs: readonly FieldDef[],
  o: Record<string, unknown>,
  mode: 'create' | 'patch',
  extra: readonly string[] = [],
): Record<string, unknown> {
  const errors = onlyKeys(o, [...defs.map((d) => d.n), ...extra]);
  const out: Record<string, unknown> = {};
  for (const f of defs) {
    const present = Object.prototype.hasOwnProperty.call(o, f.n) && o[f.n] !== undefined;
    if (!present) {
      if (mode === 'create' && f.req === true)
        errors.push({ path: `/${f.n}`, code: 'kernel.required' });
      continue;
    }
    if (mode === 'patch' && f.fixed === true) {
      errors.push({ path: `/${f.n}`, code: 'kernel.immutable' });
      continue;
    }
    if (o[f.n] === null) {
      if (f.nullable === true) out[f.n] = null;
      else errors.push({ path: `/${f.n}`, code: 'kernel.invalid_format' });
      continue;
    }
    const v = parseValue(f, o[f.n]);
    if (v === undefined) errors.push({ path: `/${f.n}`, code: 'kernel.invalid_format' });
    else out[f.n] = v;
  }
  if (errors.length > 0) throw invalid(errors);
  return out;
}

/** `limit` (1..100, default 25) and the offset cursor of a list. */
export function parsePage(q: Record<string, unknown>): { limit: number; offset: number } {
  let limit = 25;
  if (q['limit'] !== undefined) {
    const s = q['limit'];
    const n = typeof s === 'string' && /^\d{1,3}$/.test(s) ? Number(s) : NaN;
    if (!(n >= 1 && n <= 100)) throw invalidField('limit');
    limit = n;
  }
  let offset = 0;
  const c = q['cursor'];
  if (c !== undefined && c !== '') {
    if (typeof c !== 'string' || c.length > 40) throw invalidField('cursor');
    const m = /^o(\d{1,9})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
    if (m === null) throw invalidField('cursor');
    offset = Number(m[1]);
  }
  return { limit, offset };
}

export const cursorFor = (offset: number): string =>
  Buffer.from(`o${offset}`, 'utf8').toString('base64url');

/** `If-Match`: the row version in a weak or strong ETag. Absent -> 428; unreadable -> 412. */
export function ifMatchVersion(header: string | undefined): number {
  if (header === undefined || header.trim() === '')
    throw new ApiError(428, 'kernel.precondition_required');
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(header.trim());
  if (m === null) throw new ApiError(412, 'kernel.precondition_failed');
  return Number(m[1]);
}

export const etag = (version: number): string => `W/"${version}"`;
