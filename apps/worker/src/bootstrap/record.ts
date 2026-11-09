// Validation of the approved record (decision log section 4 step 1). Values only; nothing here is logged.
import type { BootstrapCustodian, BootstrapRecord } from './ports.js';

const HANDLE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : undefined;

export class InvalidRecordError extends Error {
  constructor(readonly field: string) {
    super(`approved record invalid: ${field}`);
    this.name = 'InvalidRecordError';
  }
}

export function parseRecord(raw: unknown): BootstrapRecord {
  if (!isObj(raw)) throw new InvalidRecordError('record');
  const ticketRef = text(raw['ticketRef'], 100);
  if (ticketRef === undefined) throw new InvalidRecordError('ticketRef');
  const en = raw['enrollees'];
  if (!Array.isArray(en) || en.length !== 2) throw new InvalidRecordError('enrollees');
  const enrollees = en.map((e, i) => {
    if (!isObj(e)) throw new InvalidRecordError(`enrollees[${i}]`);
    const handle = e['handle'];
    const displayName = text(e['displayName'], 200);
    if (typeof handle !== 'string' || !HANDLE.test(handle))
      throw new InvalidRecordError(`enrollees[${i}].handle`);
    if (displayName === undefined) throw new InvalidRecordError(`enrollees[${i}].displayName`);
    return { handle, displayName };
  }) as BootstrapRecord['enrollees'];
  const cu = raw['custodians'];
  if (!Array.isArray(cu) || cu.length !== 2) throw new InvalidRecordError('custodians');
  const custodians = cu.map((c, i): BootstrapCustodian => {
    if (!isObj(c)) throw new InvalidRecordError(`custodians[${i}]`);
    const idpId = text(c['idpId'], 200);
    if (idpId === undefined) throw new InvalidRecordError(`custodians[${i}].idpId`);
    if (c['enrollee'] !== undefined) {
      if (c['enrollee'] !== 1 && c['enrollee'] !== 2)
        throw new InvalidRecordError(`custodians[${i}].enrollee`);
      return { idpId, enrollee: c['enrollee'] };
    }
    const displayName = text(c['displayName'], 200);
    if (displayName === undefined) throw new InvalidRecordError(`custodians[${i}].displayName`);
    return { idpId, displayName };
  }) as BootstrapRecord['custodians'];
  const verified = raw['securityContactVerifiedAt'];
  const testRef = raw['securityContactTestRef'];
  return {
    ticketRef,
    enrollees,
    custodians,
    securityContactVerifiedAt: typeof verified === 'string' ? verified : undefined,
    securityContactTestRef: text(testRef, 200),
  };
}
