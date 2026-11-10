import type { BookingApi } from './api.js';
import type { Draft } from './context.js';
import type { Service } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Handoff {
  serviceId: string | undefined;
  clinicianId: string | undefined;
}

/** The brand-site hand-off (BS-06): `serviceId` and `clinicianId` are read only when they are UUIDs; all else is ignored. */
export function readHandoff(params: URLSearchParams): Handoff {
  const pick = (name: string): string | undefined => {
    const v = params.get(name)?.toLowerCase();
    return v !== undefined && UUID.test(v) ? v : undefined;
  };
  return { serviceId: pick('serviceId'), clinicianId: pick('clinicianId') };
}

/**
 * The draft the hand-off selects. An id that is not in the patient's bookable services, or a doctor who does not offer
 * that service, is dropped without a trace: the patient sees the normal step (nothing says whether an id exists).
 */
export async function seedDraft(
  handoff: Handoff,
  services: Service[],
  api: Pick<BookingApi, 'doctors'>,
  draft: Draft,
): Promise<Draft> {
  const service = services.find((s) => s.id.toLowerCase() === handoff.serviceId);
  if (service === undefined) return draft;
  let seeded: Draft = {
    ...draft,
    serviceId: service.id,
    clinicianId: undefined,
    mode: service.mode ?? draft.mode,
  };
  if (handoff.clinicianId !== undefined) {
    const doctors = await api.doctors(service.id, draft.locationId);
    const doctor = doctors.ok
      ? doctors.data.find((d) => d.clinicianId.toLowerCase() === handoff.clinicianId)
      : undefined;
    if (doctor !== undefined) seeded = { ...seeded, clinicianId: doctor.clinicianId };
  }
  return seeded;
}

/** Drops the ids from the address bar and history entry once they are in memory (UX-R4). */
export function clearHandoffFromUrl(): void {
  if (window.location.search !== '')
    window.history.replaceState(null, '', window.location.pathname);
}
