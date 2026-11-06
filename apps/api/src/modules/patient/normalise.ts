// Input normalisation for the values that identify a person (31.1) and the keyed hash that ties a registration to its match
// check (25.3, TDR-10). Validation lives here so that a search and a registration for the same person normalise identically:
// the hash only matches when both sides agree on every byte.
import { createHmac } from 'node:crypto';
import { normaliseText } from '../../platform/limits.js';

const NAME_MAX = 100;

/** NFC, control characters out, inner whitespace collapsed. `undefined` when empty or too long. */
export function normaliseName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = normaliseText(v).replace(/\s+/g, ' ').trim();
  if (s.length === 0 || s.length > NAME_MAX) return undefined;
  return s;
}

/** E.164. A 10-digit number is read as a US number (the product serves the US only, PRD 4). `undefined` when not a phone number. */
export function normalisePhone(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const raw = v.trim();
  if (raw.length === 0 || raw.length > 40) return undefined;
  if (!/^[+0-9()\-.\s]+$/.test(raw)) return undefined;
  const digits = raw.replace(/\D/g, '');
  let out: string;
  if (raw.startsWith('+')) out = `+${digits}`;
  else if (digits.length === 10) out = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) out = `+${digits}`;
  else return undefined;
  return /^\+[1-9][0-9]{6,14}$/.test(out) ? out : undefined;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
export function normaliseEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s.length < 3 || s.length > 320 || !EMAIL.test(s)) return undefined;
  return s;
}

/** A calendar date `YYYY-MM-DD` that exists, is not in the future and is not before 1880. */
export function normaliseDateOfBirth(v: unknown, now: Date = new Date()): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return undefined;
  if (v < '1880-01-01' || d.getTime() > now.getTime()) return undefined;
  return v;
}

export interface MatchValues {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  phone?: string | undefined;
  email?: string | undefined;
}

/**
 * HMAC-SHA256 over the normalised searched values (22.6 `values_hash`). Not reversible without the key, and the key is an
 * application secret (`<env>/app/match-check-key`), so a database reader cannot test a guess against it. Length-prefixed
 * fields keep ("ab","c") and ("a","bc") apart.
 */
export function matchValuesHash(key: string, v: MatchValues): Buffer {
  if (key.length < 16) throw new Error('match-check key too short');
  const part = (s: string): string => `${s.length}:${s}`;
  const material = [
    'patient.match.v1',
    part(v.givenName.toLowerCase()),
    part(v.familyName.toLowerCase()),
    part(v.dateOfBirth),
    part(v.phone ?? ''),
    part(v.email ?? ''),
  ].join('|');
  return createHmac('sha256', key).update(material).digest();
}
