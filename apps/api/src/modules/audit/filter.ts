import { AUDIT_ACTIONS } from './envelope.js';
import { AuditEnvelopeError } from './errors.js';
import { isUuid } from './ids.js';

/** Half-open time range `from <= occurred_at < to` (ARCHITECTURE 30: ranges are half-open). */
export interface EventFilter {
  from: Date;
  to: Date;
  actorPersonId?: string;
  patientId?: string;
  action?: string;
  resourceType?: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SEARCH_MAX_DAYS = 31;

export function validateFilter(f: EventFilter, maxDays?: number): void {
  const bad: string[] = [];
  if (!(f.from instanceof Date) || Number.isNaN(f.from.getTime())) bad.push('from');
  if (!(f.to instanceof Date) || Number.isNaN(f.to.getTime())) bad.push('to');
  if (bad.length === 0) {
    if (f.from.getTime() >= f.to.getTime()) bad.push('from', 'to');
    else if (maxDays !== undefined && f.to.getTime() - f.from.getTime() > maxDays * DAY_MS)
      bad.push('from', 'to');
  }
  if (f.actorPersonId !== undefined && !isUuid(f.actorPersonId)) bad.push('actorPersonId');
  if (f.patientId !== undefined && !isUuid(f.patientId)) bad.push('patientId');
  if (f.action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(f.action))
    bad.push('action');
  if (f.resourceType !== undefined && !/^[a-z][a-z0-9_.]{0,99}$/.test(f.resourceType))
    bad.push('resourceType');
  if (bad.length > 0) throw new AuditEnvelopeError([...new Set(bad)]);
}

/** WHERE fragment and parameters for a validated filter, parameters numbered from `first`. */
export function filterSql(f: EventFilter, first = 1): { where: string; params: unknown[] } {
  const params: unknown[] = [f.from.toISOString(), f.to.toISOString()];
  const parts = [
    `occurred_at >= $${first}::timestamptz`,
    `occurred_at < $${first + 1}::timestamptz`,
  ];
  const add = (col: string, v: string | undefined, cast = ''): void => {
    if (v === undefined) return;
    params.push(v);
    parts.push(`${col} = $${first + params.length - 1}${cast}`);
  };
  add('actor_person_id', f.actorPersonId, '::uuid');
  add('patient_id', f.patientId, '::uuid');
  add('action', f.action);
  add('resource_type', f.resourceType);
  return { where: parts.join(' AND '), params };
}
