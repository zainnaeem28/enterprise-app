import { createHash } from 'node:crypto';

/** Canonical JSON (28.3): keys sorted, no insignificant whitespace, numbers as sent (JSON.parse/stringify keep them). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface RequestFingerprint {
  method: string;
  routeTemplate: string;
  /** Resolved path parameters, in template order. */
  pathParams: readonly string[];
  query: Readonly<Record<string, string | readonly string[]>>;
  body: unknown;
}

function sortedQuery(q: RequestFingerprint['query']): string {
  const pairs: string[] = [];
  for (const k of Object.keys(q).sort()) {
    const v = q[k]!;
    for (const x of typeof v === 'string' ? [v] : v)
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(x)}`);
  }
  return pairs.join('&');
}

/** SHA-256 over method, route template, path parameters, sorted query and canonical body; headers excluded (28.3). */
export function requestHash(f: RequestFingerprint): Buffer {
  const h = createHash('sha256');
  const part = (s: string): void => {
    h.update(String(Buffer.byteLength(s)));
    h.update(':');
    h.update(s);
    h.update('\n');
  };
  part(f.method.toUpperCase());
  part(f.routeTemplate);
  part(JSON.stringify(f.pathParams));
  part(sortedQuery(f.query));
  part(f.body === undefined ? '' : canonicalJson(f.body));
  return h.digest();
}
