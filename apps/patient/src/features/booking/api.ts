import type { PatientRuntime } from '../../app/runtime.js';
import {
  parseAppointment,
  parseDoctor,
  parseHold,
  parseList,
  parsePlace,
  parseService,
  parseSlot,
} from './types.js';
import type {
  Appointment,
  Doctor,
  Hold,
  PatientRef,
  Place,
  Service,
  Slot,
  VisitMode,
} from './types.js';

/** A refused or failed call, reduced to what the screens use: status, code, request id and the alternatives of a refused slot. */
export interface Failure {
  ok: false;
  status: number;
  code: string;
  requestId?: string;
  /** Start times (ISO) offered by `scheduling.slot_taken` and `scheduling.hold_expired` (`errors[].path = /alternatives/<n>`). */
  alternatives: string[];
  retryAfterSeconds?: number;
}
export type Outcome<T> = { ok: true; data: T } | Failure;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

export function failureOf(response: Response | undefined, body: unknown): Failure {
  const b = asRecord(body);
  const errors = Array.isArray(b['errors']) ? b['errors'] : [];
  const alternatives = errors
    .map(asRecord)
    .filter((e) => typeof e['path'] === 'string' && e['path'].startsWith('/alternatives/'))
    .map((e) => e['code'])
    .filter((c): c is string => typeof c === 'string' && !Number.isNaN(Date.parse(c)));
  const retry = Number(response?.headers.get('Retry-After'));
  return {
    ok: false,
    status: response?.status ?? 0,
    code: typeof b['code'] === 'string' ? b['code'] : 'kernel.unavailable',
    ...(typeof b['requestId'] === 'string' ? { requestId: b['requestId'] } : {}),
    alternatives,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
  };
}

const unreadable = (response: Response): Failure => ({
  ok: false,
  status: response.status,
  code: 'kernel.unavailable',
  alternatives: [],
});

const network = (): Failure => ({
  ok: false,
  status: 0,
  code: 'kernel.unavailable',
  alternatives: [],
});

/** New `Idempotency-Key`: a UUID v4. One key per step; a retry of the same step reuses it (CN-06). */
export const newKey = (): string => crypto.randomUUID();

export type HoldRequest = {
  patientId: string;
  serviceId: string;
  locationId: string;
  clinicianId: string;
  startsAt: string;
  mode: VisitMode;
  reason?: string;
  patientState?: string;
  rescheduleOf?: string;
};

export type WaitlistRequest = {
  patientId: string;
  serviceId: string;
  locationId?: string;
  clinicianId?: string;
  mode: VisitMode;
};

export type BookingApi = ReturnType<typeof createBookingApi>;

/** Every call the booking screens make, over the shell's typed client (same origin, CSRF and release headers added by the shell). */
export function createBookingApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;

  async function guard<T>(
    run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
    read: (data: unknown, response: Response) => T | undefined,
  ): Promise<Outcome<T>> {
    try {
      const { data, error, response } = await run();
      if (!response.ok) return failureOf(response, error);
      const value = read(data, response);
      return value === undefined ? unreadable(response) : { ok: true, data: value };
    } catch {
      return network();
    }
  }

  return {
    /** Patients the session may book for (`GET /auth/session` -> `patients`). */
    patients: (): Promise<Outcome<PatientRef[]>> =>
      guard(
        () => api.GET('/api/v1/auth/session', { params: { header } }),
        (d) => {
          const list = asRecord(d)['patients'];
          if (!Array.isArray(list)) return undefined;
          return list
            .map(asRecord)
            .filter((p) => typeof p['patientId'] === 'string')
            .map((p) => ({
              patientId: p['patientId'] as string,
              relation: p['relation'] === 'proxy' ? ('proxy' as const) : ('self' as const),
            }));
        },
      ),

    services: (): Promise<Outcome<Service[]>> =>
      guard(
        () => api.GET('/api/v1/services', { params: { header, query: {} } }),
        (d) => parseList(d, parseService),
      ),

    locations: (): Promise<Outcome<Place[]>> =>
      guard(
        () => api.GET('/api/v1/locations', { params: { header, query: {} } }),
        (d) => parseList(d, parsePlace),
      ),

    doctors: (serviceId: string, locationId?: string): Promise<Outcome<Doctor[]>> =>
      guard(
        () =>
          api.GET('/api/v1/clinicians', {
            params: { header, query: { serviceId, ...(locationId ? { locationId } : {}) } },
          }),
        (d) => parseList(d, parseDoctor),
      ),

    search: (q: {
      serviceId: string;
      locationId?: string;
      clinicianId?: string;
      mode: VisitMode;
      from: string;
      to: string;
    }): Promise<Outcome<{ slots: Slot[]; stale: boolean }>> =>
      guard(
        () => api.POST('/api/v1/availability/search', { params: { header }, body: q }),
        (d) => {
          const o = asRecord(d);
          if (!Array.isArray(o['slots'])) return undefined;
          return {
            slots: o['slots'].map(parseSlot).filter((s): s is Slot => s !== undefined),
            stale: o['availabilityStale'] === true,
          };
        },
      ),

    hold: (body: HoldRequest, key: string): Promise<Outcome<Hold>> =>
      guard(
        () =>
          api.POST('/api/v1/holds', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body,
          }),
        (d, response) => {
          const server = Date.parse(response.headers.get('Date') ?? '');
          return parseHold(d, Number.isNaN(server) ? 0 : server - Date.now());
        },
      ),

    confirm: (reservationId: string, key: string): Promise<Outcome<Appointment>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/confirm', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { reservationId } },
          }),
        (d) => parseAppointment(d),
      ),

    appointments: (patientId: string): Promise<Outcome<Appointment[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/appointments', {
            params: {
              header,
              path: { patientId },
              query: { status: 'confirmed', from: new Date().toISOString() },
            },
          }),
        (d) => parseList(d, parseAppointment),
      ),

    appointment: (reservationId: string): Promise<Outcome<Appointment>> =>
      guard(
        () =>
          api.GET('/api/v1/appointments/{reservationId}', {
            params: { header, path: { reservationId } },
          }),
        (d) => parseAppointment(d),
      ),

    reschedule: (
      reservationId: string,
      newHoldId: string,
      version: number,
      key: string,
    ): Promise<Outcome<Appointment>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/reschedule', {
            params: {
              header: { ...header, 'Idempotency-Key': key, 'If-Match': `W/"${version}"` },
              path: { reservationId },
            },
            body: { newHoldId },
          }),
        (d) => parseAppointment(d),
      ),

    /** `acceptFee` is never sent: the portal shows and charges no fee (D-3, block-only default). */
    cancel: (
      reservationId: string,
      version: number,
      key: string,
      reason?: string,
    ): Promise<Outcome<Appointment>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/cancel', {
            params: {
              header: { ...header, 'Idempotency-Key': key, 'If-Match': `W/"${version}"` },
              path: { reservationId },
            },
            body: reason ? { reason } : {},
          }),
        (d) => parseAppointment(d),
      ),

    joinWaitlist: (body: WaitlistRequest, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/waitlist-entries', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body,
          }),
        () => true as const,
      ),

    acceptOffer: (offerId: string, key: string): Promise<Outcome<Appointment | true>> =>
      guard(
        () =>
          api.POST('/api/v1/waitlist-offers/{offerId}/accept', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { offerId } },
          }),
        (d) => parseAppointment(d) ?? true,
      ),

    declineOffer: (offerId: string, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/waitlist-offers/{offerId}/decline', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { offerId } },
          }),
        () => true as const,
      ),
  };
}
