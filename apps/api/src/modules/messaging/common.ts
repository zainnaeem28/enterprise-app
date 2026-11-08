// Small shared helpers of the messaging services: value parsing, the flag read, cursors. No SQL on messaging tables here.
import type { Tx } from '@ehr/kernel';
import { MessagingNotFoundError, MessagingScopeError, MessagingValidationError } from './errors.js';
import { isUuid } from './ids.js';

export type Row = Record<string, unknown>;

export const PATIENT_MESSAGING_FLAG = 'patient_messaging';
export const MAX_SUBJECT = 200;
export const MAX_BODY_BYTES = 10240;
export const MAX_TITLE = 200;
export const MAX_DETAIL_BYTES = 5120;
export const MAX_PARTICIPANTS = 50;
export const MAX_ATTACHMENTS = 10;

export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);

export function principalOf(tx: Tx): string {
  const p = tx.scope.principalId;
  if (p === undefined) throw new MessagingScopeError();
  return p;
}

/** Staff (google realm) only: the routes of 29.3 carry a permission, and this is the second line. */
export function mustBeStaff(tx: Tx): void {
  if (tx.scope.audience !== 'staff' || tx.scope.realm !== 'google') throw new MessagingScopeError();
}

export function mustBePatient(tx: Tx): void {
  if (tx.scope.audience !== 'patient') throw new MessagingScopeError();
}

export function uuidField(v: unknown, field: string): string {
  if (!isUuid(v)) throw new MessagingValidationError([field]);
  return v.toLowerCase();
}

export function optionalUuid(v: unknown, field: string): string | null {
  return v === undefined || v === null ? null : uuidField(v, field);
}

/** A text of 1..max characters after trimming (and at most maxBytes bytes when given). */
export function textField(v: unknown, field: string, max: number, maxBytes?: number): string {
  if (typeof v !== 'string') throw new MessagingValidationError([field]);
  const t = v.trim();
  if (t.length < 1 || t.length > max || (maxBytes !== undefined && Buffer.byteLength(v) > maxBytes))
    throw new MessagingValidationError([field]);
  return v;
}

export function uuidList(v: unknown, field: string, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new MessagingValidationError([field]);
  const out = v.map((x) => uuidField(x, field));
  return [...new Set(out)];
}

/** Rejects a body with a key the route does not accept (a typo must not be silently ignored). */
export function onlyKeys(input: Row, allowed: readonly string[]): void {
  const bad = Object.keys(input).filter((k) => !allowed.includes(k));
  if (bad.length > 0) throw new MessagingValidationError(bad);
}

/** The organisation flag `patient_messaging` (D-5, default off): the organisation-wide row only; absent means off. */
export async function patientMessagingOn(tx: Tx): Promise<boolean> {
  const r = await tx.query(
    `SELECT enabled FROM organisation.feature_flag WHERE key = $1 AND location_id IS NULL`,
    [PATIENT_MESSAGING_FLAG],
  );
  return (r.rows[0] as Row | undefined)?.['enabled'] === true;
}

export async function requirePatientMessaging(tx: Tx): Promise<void> {
  if (!(await patientMessagingOn(tx))) throw new MessagingNotFoundError();
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset cursor: `<timestamp text>|<uuid>`, base64url. */
export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`).toString('base64url');
}
export function decodeCursor(c: string | undefined): { ts: string; id: string } | null {
  if (c === undefined) return null;
  const s = Buffer.from(c, 'base64url').toString('utf8');
  const i = s.indexOf('|');
  const ts = s.slice(0, i);
  const id = s.slice(i + 1);
  if (i < 0 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(ts) || !isUuid(id))
    throw new MessagingValidationError(['cursor']);
  return { ts, id };
}
export const clampLimit = (n: number | undefined): number =>
  Math.min(Math.max(Math.trunc(n ?? 50), 1), 200);

export const TS_SQL = (col: string): string =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
