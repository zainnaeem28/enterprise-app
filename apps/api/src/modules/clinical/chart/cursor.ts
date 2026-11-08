// Opaque list cursors (28.2): base64url of the sort key, HMAC-signed so a client cannot forge one to probe ranges.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChartValidationError } from './errors.js';

export interface CursorKey {
  /** ISO time of `created_at` of the last row returned. */
  c: string;
  /** Its id. */
  i: string;
}

const sign = (key: string, body: string): string =>
  createHmac('sha256', key).update(body).digest('base64url');

export function encodeCursor(key: string, k: CursorKey): string {
  const body = Buffer.from(JSON.stringify(k), 'utf8').toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export function decodeCursor(key: string, raw: string): CursorKey {
  const bad = (): never => {
    throw new ChartValidationError(['cursor']);
  };
  const [body, mac, extra] = raw.split('.');
  if (body === undefined || mac === undefined || extra !== undefined || raw.length > 400)
    return bad();
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return bad();
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CursorKey>;
    if (typeof v.c !== 'string' || typeof v.i !== 'string' || Number.isNaN(Date.parse(v.c)))
      return bad();
    return { c: v.c, i: v.i };
  } catch {
    return bad();
  }
}

/** `?limit=` 1..100, default 25 (28.2). */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return 25;
  const n = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ChartValidationError(['limit']);
  return n;
}
