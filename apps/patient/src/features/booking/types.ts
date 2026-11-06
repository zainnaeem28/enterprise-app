// Domain shapes the booking screens read. The contract types most of these bodies as opaque objects
// (scheduling.yaml, organisation.yaml), so each one is checked here and a malformed answer is treated as a
// server error instead of rendering `undefined`. Field names follow apps/api scheduling core `AppointmentView`
// and the organisation directory views (migration 0302). Assumptions are listed in README.md.

export type VisitMode = 'in_person' | 'video';

export interface Service {
  id: string;
  name: string;
  durationMin: number | undefined;
  /** `in_person`, `video`, or undefined when the service can be either. */
  mode: VisitMode | undefined;
}

export interface Place {
  id: string;
  name: string;
  timeZone: string | undefined;
}

export interface Doctor {
  clinicianId: string;
  displayName: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  clinicianId: string;
  locationId: string;
  mode: VisitMode;
}

export interface Appointment {
  id: string;
  patientId: string;
  serviceId: string;
  locationId: string;
  locationTimeZone: string;
  clinicianId: string;
  mode: VisitMode;
  status: string;
  startsAt: string;
  endsAt: string;
  version: number;
}

export interface Hold {
  reservationId: string;
  expiresAt: string;
  /** Server clock minus local clock when the hold answer arrived (from the `Date` header), so the countdown never trusts the device clock alone. */
  clockOffsetMs: number;
}

export interface PatientRef {
  patientId: string;
  relation: 'self' | 'proxy';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const isMode = (v: unknown): v is VisitMode => v === 'in_person' || v === 'video';

export function parseService(v: unknown): Service | undefined {
  if (!isObject(v)) return undefined;
  const id = str(v['id']);
  const name = str(v['patientDisplayName']) ?? str(v['name']);
  if (id === undefined || name === undefined) return undefined;
  const mins = v['durationMin'];
  return {
    id,
    name,
    durationMin: typeof mins === 'number' ? mins : undefined,
    mode: isMode(v['mode']) ? v['mode'] : undefined,
  };
}

export function parsePlace(v: unknown): Place | undefined {
  if (!isObject(v)) return undefined;
  const id = str(v['id']);
  const name = str(v['name']);
  if (id === undefined || name === undefined) return undefined;
  return { id, name, timeZone: str(v['timeZone']) };
}

export function parseDoctor(v: unknown): Doctor | undefined {
  if (!isObject(v)) return undefined;
  const clinicianId = str(v['clinicianId']);
  const displayName = str(v['displayName']);
  return clinicianId === undefined || displayName === undefined
    ? undefined
    : { clinicianId, displayName };
}

export function parseSlot(v: unknown): Slot | undefined {
  if (!isObject(v)) return undefined;
  const startsAt = str(v['startsAt']);
  const endsAt = str(v['endsAt']);
  const clinicianId = str(v['clinicianId']);
  const locationId = str(v['locationId']);
  if (
    startsAt === undefined ||
    endsAt === undefined ||
    clinicianId === undefined ||
    locationId === undefined ||
    !isMode(v['mode']) ||
    Number.isNaN(Date.parse(startsAt))
  )
    return undefined;
  return { startsAt, endsAt, clinicianId, locationId, mode: v['mode'] };
}

export function parseAppointment(v: unknown): Appointment | undefined {
  if (!isObject(v)) return undefined;
  const id = str(v['id']);
  const startsAt = str(v['startsAt']);
  const endsAt = str(v['endsAt']);
  const status = str(v['status']);
  const patientId = str(v['patientId']);
  const serviceId = str(v['serviceId']);
  const locationId = str(v['locationId']);
  const clinicianId = str(v['clinicianId']);
  if (
    id === undefined ||
    startsAt === undefined ||
    endsAt === undefined ||
    status === undefined ||
    patientId === undefined ||
    serviceId === undefined ||
    locationId === undefined ||
    clinicianId === undefined ||
    !isMode(v['mode']) ||
    Number.isNaN(Date.parse(startsAt))
  )
    return undefined;
  const tz = str(v['locationTimeZone']) ?? 'UTC';
  const version = typeof v['version'] === 'number' ? v['version'] : 0;
  return {
    id,
    patientId,
    serviceId,
    locationId,
    locationTimeZone: tz,
    clinicianId,
    mode: v['mode'],
    status,
    startsAt,
    endsAt,
    version,
  };
}

export function parseHold(v: unknown, clockOffsetMs: number): Hold | undefined {
  if (!isObject(v)) return undefined;
  const reservationId = str(v['reservationId']);
  const expiresAt = str(v['expiresAt']);
  if (reservationId === undefined || expiresAt === undefined || Number.isNaN(Date.parse(expiresAt)))
    return undefined;
  return { reservationId, expiresAt, clockOffsetMs };
}

export function parseList<T>(v: unknown, parse: (x: unknown) => T | undefined): T[] {
  const items = isObject(v) ? v['items'] : undefined;
  return Array.isArray(items) ? items.map(parse).filter((x): x is T => x !== undefined) : [];
}
