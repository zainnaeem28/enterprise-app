// Attribute scrubbing for spans, events, links and resources. Pure functions; no OpenTelemetry import.
import {
  ALLOWED_ATTRIBUTE_KEYS,
  BLOCKED_VALUE_PATTERNS,
  MAX_VALUE_LENGTH,
  REDACTED,
} from './allowlist.js';

export type AttributeValue = string | number | boolean | ReadonlyArray<string | number | boolean>;
export type Attributes = Readonly<Record<string, unknown>>;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_NUMBER = /\b[0-9]{5,}\b/g;

/** A route must be a template. Identifiers that slipped into one are replaced so a patient or resource id never becomes a metric dimension. */
export function normaliseRoute(route: string): string {
  return route.replace(UUID, ':id').replace(LONG_NUMBER, ':id').split('?')[0] ?? '';
}

export function scrubString(value: string): string {
  if (value.length > MAX_VALUE_LENGTH) return REDACTED;
  return BLOCKED_VALUE_PATTERNS.some((re) => re.test(value)) ? REDACTED : value;
}

function scrubValue(key: string, value: unknown): AttributeValue | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return key === 'http.route' ? scrubString(normaliseRoute(value)) : scrubString(value);
  if (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  )
    return value.map((v) => (typeof v === 'string' ? scrubString(v) : v));
  return undefined; // objects, functions, bigint, null: not telemetry
}

export interface Scrubbed {
  readonly attributes: Record<string, AttributeValue>;
  /** Number of keys dropped for not being on the allowlist or not being a primitive. Names are never returned. */
  readonly dropped: number;
}

export function scrubAttributes(attrs: Attributes | undefined): Scrubbed {
  const out: Record<string, AttributeValue> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(k)) {
      dropped += 1;
      continue;
    }
    const s = scrubValue(k, v);
    if (s === undefined) dropped += 1;
    else out[k] = s;
  }
  return { attributes: out, dropped };
}

/** Span names are written by instrumentation and can contain a path or query. Keep the method and a templated path only. */
export function scrubSpanName(name: string): string {
  const m = /^([A-Z]+)\s+(\S+)/.exec(name);
  if (m) return scrubString(`${m[1]} ${normaliseRoute(m[2] ?? '')}`);
  return scrubString(name);
}
