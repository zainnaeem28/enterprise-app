// Small helpers shared by the front-door services.
import type { Tx } from '@ehr/kernel';
import { FrontdoorNotFoundError, FrontdoorScopeError } from './errors.js';
import { isUuid } from './ids.js';

export type Row = Record<string, unknown>;

export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);
export const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
export const dateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/** The signed-in staff principal of the transaction, or a 404 (a front-door write is a staff act under the staff scope). */
export function staffPrincipal(tx: Tx): string {
  const p = tx.scope.principalId;
  if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
    throw new FrontdoorNotFoundError();
  return p;
}

export function patientScopeOnly(tx: Tx): string {
  const p = tx.scope.principalId;
  if (tx.scope.audience !== 'patient' || p === undefined || !isUuid(p))
    throw new FrontdoorScopeError();
  return p;
}

/** Keys of a free-form answer object: short, plain identifiers (a question ID), never a path or a prototype key. */
export const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** True for a JSON scalar or a short list of scalars: no nested objects in an answer. */
export function answerValueOk(v: unknown): boolean {
  const scalar = (x: unknown): boolean =>
    x === null ||
    typeof x === 'boolean' ||
    (typeof x === 'number' && Number.isFinite(x)) ||
    (typeof x === 'string' && x.length <= 5000);
  return scalar(v) || (Array.isArray(v) && v.length <= 100 && v.every(scalar));
}

/** Validates an answers object: plain, within bounds. Returns the offending keys (empty when fine). */
export function badAnswerKeys(a: unknown): string[] {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return ['answers'];
  const bad: string[] = [];
  const entries = Object.entries(a as Record<string, unknown>);
  if (entries.length > 300) return ['answers'];
  for (const [k, v] of entries) if (!KEY.test(k) || !answerValueOk(v)) bad.push(`answers/${k}`);
  if (JSON.stringify(a).length > 60_000) bad.push('answers');
  return bad;
}
