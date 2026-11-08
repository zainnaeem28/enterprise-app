import { guard, matchHeader, rec, str } from '../preconsult/http.js';
import type { Api, Outcome } from '../preconsult/http.js';
import {
  parseAck,
  parseAddendum,
  parseAlert,
  parseChartSummary,
  parseEncounter,
  parseNote,
  parseNoteListItem,
  parseOpenId,
  parsePatientHit,
  parseVisit,
  parseWaiting,
} from './types.js';
import type {
  AckResult,
  Addendum,
  AlertItem,
  Banner,
  ChartSummary,
  Encounter,
  Note,
  NoteListItem,
  OpenAlertId,
  PatientHit,
  Visit,
  WaitingParticipant,
} from './types.js';

type LooseCall = (
  path: string,
  init: {
    params: {
      header: Record<string, string>;
      path?: Record<string, string>;
      query?: Record<string, string>;
    };
    body?: unknown;
  },
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

function listOf<T>(parse: (v: unknown) => T | undefined, key = 'items') {
  return (d: unknown): T[] | undefined => {
    const items = rec(d)[key];
    if (!Array.isArray(items)) return undefined;
    const out = items.map(parse);
    return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
  };
}

/**
 * Every call the doctor portal makes, over the shell's typed client (CSRF and release headers are added by the shell).
 * Bodies follow the API controllers; the generated request and response types of these operations are `OpaqueObject`.
 */
export function createDoctorApi(api: Api) {
  const header = api.header;
  const loose = api as unknown as Record<'GET' | 'POST' | 'PATCH', LooseCall>;

  return {
    /** `GET /clinicians/{id}/schedule` (scheduling.booking.own_schedule): the caller's own reservations of one location-day. */
    schedule: (clinicianId: string, locationId: string, date?: string): Promise<Outcome<Visit[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/schedule', {
            params: {
              header,
              path: { id: clinicianId },
              query: date === undefined ? { locationId } : { locationId, date },
            },
          }),
        listOf(parseVisit),
      ),

    /** `POST /patients/lookup` (patient.lookup): exactly one criteria form; in-scope patients only. */
    lookupPatients: (
      q: { mrn: string } | { name: string; dateOfBirth?: string } | { patientIds: string[] },
    ): Promise<Outcome<{ items: PatientHit[]; truncated: boolean }>> =>
      guard(
        () => loose.POST('/api/v1/patients/lookup', { params: { header }, body: q }),
        (d) => {
          const items = listOf(parsePatientHit)(d);
          return items === undefined
            ? undefined
            : { items, truncated: rec(d)['truncated'] === true };
        },
      ),

    /** `GET /clinicians/{id}/notes`: the caller's own drafts and notes waiting for co-signature. */
    myNotes: (clinicianId: string): Promise<Outcome<NoteListItem[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/notes', {
            params: { header, path: { id: clinicianId } },
          }),
        listOf(parseNoteListItem),
      ),

    /** `GET /clinicians/{id}/cosign-queue` (clinical.note.cosign): notes waiting for this supervisor. */
    cosignQueue: (clinicianId: string): Promise<Outcome<NoteListItem[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/cosign-queue', {
            params: { header, path: { id: clinicianId } },
          }),
        listOf(parseNoteListItem),
      ),

    /** `GET /notes/{id}`: one note with its sections, on the first read basis that applies. */
    getNote: (noteId: string): Promise<Outcome<Note>> =>
      guard(
        () => loose.GET('/api/v1/notes/{id}', { params: { header, path: { id: noteId } } }),
        parseNote,
      ),

    /** A refusal keeps the `btgAvailable` extension member (ARCHITECTURE 30) so the screen can offer break-the-glass. */
    chartSummary: async (
      patientId: string,
    ): Promise<Outcome<ChartSummary> & { btgAvailable?: boolean }> => {
      let btg = false;
      const o = await guard(async () => {
        const r = await api.GET('/api/v1/patients/{patientId}/chart-summary', {
          params: { header, path: { patientId } },
        });
        btg = rec(r.error)['btgAvailable'] === true;
        return r;
      }, parseChartSummary);
      return o.ok ? o : { ...o, btgAvailable: btg };
    },

    /** Name and date of birth for an alert row through the minimised lookup (the doctor role holds no `patient.read`). */
    banner: (patientId: string): Promise<Outcome<Banner>> =>
      guard(
        () =>
          loose.POST('/api/v1/patients/lookup', {
            params: { header },
            body: { patientIds: [patientId] },
          }),
        (d) => {
          const hit = listOf(parsePatientHit)(d)?.[0];
          return hit === undefined
            ? undefined
            : {
                patientId: hit.id,
                displayName: `${hit.givenName} ${hit.familyName}`,
                dateOfBirth: hit.dateOfBirth,
                mrn: hit.mrn,
                allergies: null,
              };
        },
      ),

    breakGlass: (
      patientId: string,
      reason: string,
      key: string,
    ): Promise<Outcome<{ grantId: string; expiresAt: string }>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/break-glass', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body: { reason },
          }),
        (d) => {
          const r = rec(d);
          const grantId = str(r['grantId']);
          const expiresAt = str(r['expiresAt']);
          return grantId === undefined || expiresAt === undefined
            ? undefined
            : { grantId, expiresAt };
        },
      ),

    startEncounter: (
      reservationId: string,
      key: string,
      emergencyReason?: string,
    ): Promise<Outcome<Encounter>> =>
      guard(
        () =>
          api.POST('/api/v1/encounters', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body:
              emergencyReason === undefined
                ? { reservationId }
                : { reservationId, emergencyException: { reason: emergencyReason } },
          }),
        parseEncounter,
      ),

    createNote: (encounterId: string, key: string): Promise<Outcome<Note>> =>
      guard(
        () =>
          api.POST('/api/v1/encounters/{id}/notes', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: encounterId } },
            body: {},
          }),
        parseNote,
      ),

    saveNote: (
      noteId: string,
      version: number,
      sections: Record<string, string>,
    ): Promise<Outcome<Note>> =>
      guard(
        () =>
          api.PATCH('/api/v1/notes/{id}', {
            params: { header: { ...header, ...matchHeader(version) }, path: { id: noteId } },
            body: { sections },
          }),
        parseNote,
      ),

    signNote: (noteId: string, version: number, key: string): Promise<Outcome<Note>> =>
      guard(
        () =>
          api.POST('/api/v1/notes/{id}/sign', {
            params: {
              header: { ...header, 'Idempotency-Key': key, ...matchHeader(version) },
              path: { id: noteId },
            },
          }),
        parseNote,
      ),

    cosignNote: (noteId: string, key: string): Promise<Outcome<Note>> =>
      guard(
        () =>
          api.POST('/api/v1/notes/{id}/cosign', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: noteId } },
          }),
        parseNote,
      ),

    addAddendum: (noteId: string, body: string, key: string): Promise<Outcome<Addendum>> =>
      guard(
        () =>
          api.POST('/api/v1/notes/{id}/addenda', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: noteId } },
            body: { body },
          }),
        parseAddendum,
      ),

    /** The list and the server time from the `Date` header: countdowns never use the device clock alone (UI-UX 7.4). */
    alerts: async (): Promise<Outcome<{ items: AlertItem[]; serverNow: number | null }>> => {
      let serverNow: number | null = null;
      return guard(
        async () => {
          const r = await api.GET('/api/v1/alerts', { params: { header, query: {} } });
          const t = Date.parse(r.response.headers.get('Date') ?? '');
          serverNow = Number.isNaN(t) ? null : t;
          return r;
        },
        (d) => {
          const items = listOf(parseAlert)(d);
          return items === undefined ? undefined : { items, serverNow };
        },
      );
    },

    /** The passive 60 s poll: refreshes `escalatesAt`, level and status without extending the idle clock (UI-UX 7.4). */
    openAlertIds: (): Promise<Outcome<OpenAlertId[]>> =>
      guard(() => api.GET('/api/v1/alerts/open-ids', { params: { header } }), listOf(parseOpenId)),

    acknowledge: (alertId: string, key: string): Promise<Outcome<AckResult>> =>
      guard(
        () =>
          api.POST('/api/v1/alerts/{id}/acknowledge', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: alertId } },
          }),
        parseAck,
      ),

    /** Host side of the waiting room. The staff paths carry `/host` on the telehealth branch (BE-15 D1); not in the generated types. */
    waiting: (reservationId: string): Promise<Outcome<WaitingParticipant[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/appointments/{id}/video-session/host', {
            params: { header, path: { id: reservationId } },
          }),
        parseWaiting,
      ),

    admit: (reservationId: string, key: string, participantId?: string): Promise<Outcome<true>> =>
      guard(
        () =>
          loose.POST('/api/v1/appointments/{id}/video-session/admit', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: reservationId } },
            body: participantId === undefined ? {} : { participantId },
          }),
        () => true as const,
      ),

    endVideo: (reservationId: string, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          loose.POST('/api/v1/appointments/{id}/video-session/end', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: reservationId } },
          }),
        () => true as const,
      ),
  };
}
export type DoctorApi = ReturnType<typeof createDoctorApi>;
