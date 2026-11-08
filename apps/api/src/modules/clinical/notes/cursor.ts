// Bound list cursors of the notes routes (decision HEAAA-286, SEC288-F05): an HMAC-SHA256-signed payload in the same `body.mac` format
// as the chart's cursor, bound to the principal, the route and the status filter, and valid for 15 minutes. `chart/cursor.ts` is not
// changed. Every failure is `kernel.validation_failed` with error path `/cursor`.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotesValidationError } from './errors.js';

export type CursorRoute = 'notes' | 'cosign-queue';

/** How long an issued cursor stays valid (15 minutes). */
export const CURSOR_TTL_MS = 15 * 60_000;

export interface NotesCursor {
  /** The sort key of the last row returned, as an ISO time. */
  k: string;
  /** Its id. */
  i: string;
}

interface Payload extends NotesCursor {
  p: string;
  r: CursorRoute;
  f: string;
  x: string;
}

const sign = (key: string, body: string): string =>
  createHmac('sha256', key).update(body).digest('base64url');

/** The sorted status filter, as it is bound into the cursor. */
export const filterKey = (statuses: readonly string[]): string => [...statuses].sort().join(',');

export function encodeCursor(
  key: string,
  now: Date,
  bind: { principalId: string; route: CursorRoute; filter: string },
  at: NotesCursor,
): string {
  const payload: Payload = {
    k: at.k,
    i: at.i,
    p: bind.principalId.toLowerCase(),
    r: bind.route,
    f: bind.filter,
    x: new Date(now.getTime() + CURSOR_TTL_MS).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export function decodeCursor(
  key: string,
  now: Date,
  bind: { principalId: string; route: CursorRoute; filter: string },
  raw: string,
): NotesCursor {
  const bad = (): never => {
    throw new NotesValidationError(['cursor']);
  };
  const [body, mac, extra] = raw.split('.');
  if (body === undefined || mac === undefined || extra !== undefined || raw.length > 600)
    return bad();
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return bad();
  let v: Partial<Payload>;
  try {
    v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
  } catch {
    return bad();
  }
  if (
    typeof v.k !== 'string' ||
    typeof v.i !== 'string' ||
    typeof v.p !== 'string' ||
    typeof v.r !== 'string' ||
    typeof v.f !== 'string' ||
    typeof v.x !== 'string' ||
    Number.isNaN(Date.parse(v.k)) ||
    Number.isNaN(Date.parse(v.x))
  )
    return bad();
  if (v.p !== bind.principalId.toLowerCase() || v.r !== bind.route || v.f !== bind.filter)
    return bad();
  if (Date.parse(v.x) <= now.getTime()) return bad();
  return { k: v.k, i: v.i };
}
