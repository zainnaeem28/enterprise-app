// Redacting logger core (NFR-13/18, TICKETS 3: no PHI or synthetic-PHI canary in logs). Two layers:
//  1. field names: only an allowlist of operational keys keep their string values; every other string is replaced;
//  2. value patterns: the allowed strings (and the free-text message) are scrubbed for identifier shapes.
// Numbers and booleans pass: they carry no text. Errors are reduced to name and code.

export const REDACTED = '[redacted]';

const SAFE_KEYS = new Set([
  'level',
  'time',
  'msg',
  'message',
  'requestId',
  'method',
  'route',
  'routeTemplate',
  'status',
  'code',
  'durationMs',
  'module',
  'job',
  'jobType',
  'jobId',
  'attempt',
  'sqlstate',
  'event',
  'component',
  'releaseId',
  'organisationId',
  'principalId',
  'audience',
  'realm',
  'name',
  // vendor call lines (DL-1, HEAAA-707): closed vocabularies and class names only, never a vendor message
  'kind',
  'vendor',
  'operation',
  'outcome',
  'errorClass',
  'correlationId',
  // replica lines (HEAAA-860): a Region name is not patient data
  'region',
]);

const PATTERNS: [RegExp, string][] = [
  [/CANARY[-_A-Z0-9]*/gi, REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED],
  [/\b(?:\+?\d[\s().-]?){10,15}\b/g, REDACTED],
  [/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, REDACTED],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const MAX_DEPTH = 6;

export function redactValue(value: unknown, key: string | undefined, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (key !== undefined && !SAFE_KEYS.has(key)) return REDACTED;
    return scrubString(value);
  }
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, ...(typeof code === 'string' ? { code: scrubString(code) } : {}) };
  }
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k, depth + 1);
    }
    return out;
  }
  return REDACTED; // functions, symbols
}
