import { arr, guard, matchHeader, rec, str } from './http.js';
import type { Api, Outcome } from './http.js';
import {
  parseArrival,
  parseBannerResponse,
  parseCheckIn,
  parseConsent,
  parseCurrentTriage,
  parseDuplicateFlag,
  parseFollowUp,
  parseMatch,
  parsePatientHit,
  parseMerge,
  parseQuestionnaire,
  parseQueueEntry,
  parseTriageSaved,
  parseVitalsResult,
} from './types.js';
import type {
  Arrival,
  Banner,
  CheckInResult,
  ConsentRow,
  CurrentTriage,
  DuplicateFlag,
  FollowUp,
  MatchResult,
  MergeRequest,
  PatientHit,
  QuestionnaireRow,
  QueueEntry,
  QueueStage,
  TriageCategory,
  TriageSaved,
  VitalsResult,
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

/** Maps `items` of a list answer through a parser; a single unreadable row makes the whole answer unreadable. */
function listOf<T>(parse: (v: unknown) => T | undefined) {
  return (d: unknown): T[] | undefined => {
    const items = rec(d)['items'];
    if (!Array.isArray(items)) return undefined;
    const out = items.map(parse);
    return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
  };
}

export interface VitalInput {
  loincCode: string;
  value: number;
  unit: string;
  measuredAt: string;
}

export interface RegisterInput {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  stateCode: string;
  phone?: string;
  email?: string;
  locationId: string;
  matchCheckId: string;
  duplicateAcknowledged?: boolean;
  acknowledgeReason?: string;
}

/**
 * Every call the pre-consultation desk makes, over the shell's typed client (CSRF and release headers are added by the shell).
 * Bodies follow the API controllers; the generated request types for these operations are `OpaqueObject`.
 */
export function createPreconsultApi(api: Api) {
  const header = api.header;
  // Routes the API serves (clinical/frontdoor controller, "additive to the 29.3 table") but `clinical.yaml` does not list yet:
  // GET /check-ins/{id}/triage and the follow-up routes. They go through the same client (release, CSRF and session handling
  // included) but untyped. A contract addition is requested in the evidence notes; switch to the typed calls when it lands.
  const loose = api as unknown as Record<'GET' | 'POST' | 'PATCH', LooseCall>;

  return {
    arrivals: (locationId: string, date?: string): Promise<Outcome<Arrival[]>> =>
      guard(
        () =>
          api.GET('/api/v1/locations/{locationId}/arrivals', {
            params: { header, path: { locationId }, query: date === undefined ? {} : { date } },
          }),
        listOf(parseArrival),
      ),

    qr: (locationId: string): Promise<Outcome<{ token: string; localDate: string }>> =>
      guard(
        () =>
          api.GET('/api/v1/locations/{locationId}/check-in-qr', {
            params: { header, path: { locationId } },
          }),
        (d) => {
          const r = rec(d);
          const token = str(r['token']);
          const localDate = str(r['localDate']);
          return token === undefined || localDate === undefined ? undefined : { token, localDate };
        },
      ),

    checkIn: (
      reservationId: string,
      version: number,
      key: string,
    ): Promise<Outcome<CheckInResult>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{id}/check-in', {
            params: {
              header: { ...header, 'Idempotency-Key': key, ...matchHeader(version) },
              path: { id: reservationId },
            },
          }),
        parseCheckIn,
      ),

    noShow: (reservationId: string, version: number, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{id}/no-show', {
            params: {
              header: { ...header, 'Idempotency-Key': key, ...matchHeader(version) },
              path: { id: reservationId },
            },
          }),
        () => true as const,
      ),

    queue: (locationId: string): Promise<Outcome<QueueEntry[]>> =>
      guard(
        () =>
          api.GET('/api/v1/locations/{locationId}/queue', {
            params: { header, path: { locationId } },
          }),
        listOf(parseQueueEntry),
      ),

    setStage: (entryId: string, stage: QueueStage, version: number): Promise<Outcome<QueueEntry>> =>
      guard(
        () =>
          api.PUT('/api/v1/queue-entries/{id}/stage', {
            params: { header: { ...header, ...matchHeader(version) }, path: { id: entryId } },
            body: { stage },
          }),
        parseQueueEntry,
      ),

    recordVitals: (
      checkInId: string,
      vitals: VitalInput[],
      key: string,
    ): Promise<Outcome<VitalsResult>> =>
      guard(
        () =>
          api.POST('/api/v1/check-ins/{id}/vitals', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { id: checkInId } },
            body: { vitals },
          }),
        parseVitalsResult,
      ),

    currentTriage: (checkInId: string): Promise<Outcome<CurrentTriage>> =>
      guard(
        () =>
          loose.GET('/api/v1/check-ins/{id}/triage', {
            params: { header, path: { id: checkInId } },
          }),
        parseCurrentTriage,
      ),

    /** `chainLength` is the ETag of the current assessment: sent for a re-triage, omitted for the first. */
    recordTriage: (
      checkInId: string,
      input: { category: TriageCategory; notes?: string },
      chainLength: number | undefined,
      key: string,
    ): Promise<Outcome<TriageSaved>> =>
      guard(
        () =>
          api.POST('/api/v1/check-ins/{id}/triage', {
            params: {
              header: {
                ...header,
                'Idempotency-Key': key,
                ...(chainLength === undefined ? {} : matchHeader(chainLength)),
              },
              path: { id: checkInId },
            },
            body: input,
          }),
        parseTriageSaved,
      ),

    banner: (patientId: string): Promise<Outcome<Banner>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/banner', {
            params: { header, path: { patientId } },
          }),
        parseBannerResponse,
      ),

    patient: (patientId: string): Promise<Outcome<PatientHit>> =>
      guard(
        () => api.GET('/api/v1/patients/{patientId}', { params: { header, path: { patientId } } }),
        parsePatientHit,
      ),

    consents: (patientId: string): Promise<Outcome<ConsentRow[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/consents', {
            params: { header, path: { patientId }, query: {} },
          }),
        listOf(parseConsent),
      ),

    questionnaires: (patientId: string): Promise<Outcome<QuestionnaireRow[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/questionnaire-responses', {
            params: { header, path: { patientId }, query: {} },
          }),
        listOf(parseQuestionnaire),
      ),

    followUps: (locationId: string, status?: string): Promise<Outcome<FollowUp[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/locations/{locationId}/follow-ups', {
            params: {
              header,
              path: { locationId },
              query: status === undefined ? {} : { status },
            },
          }),
        listOf(parseFollowUp),
      ),

    createFollowUp: (
      patientId: string,
      input: { locationId: string; dueOn: string; reason: string },
      key: string,
    ): Promise<Outcome<FollowUp>> =>
      guard(
        () =>
          loose.POST('/api/v1/patients/{patientId}/follow-ups', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body: input,
          }),
        parseFollowUp,
      ),

    setFollowUpStatus: (
      id: string,
      status: 'done' | 'cancelled',
      version: number,
    ): Promise<Outcome<FollowUp>> =>
      guard(
        () =>
          loose.PATCH('/api/v1/follow-ups/{id}', {
            params: { header: { ...header, ...matchHeader(version) }, path: { id } },
            body: { status },
          }),
        parseFollowUp,
      ),

    searchPatients: (q: {
      name?: string;
      dateOfBirth?: string;
      mrn?: string;
      phone?: string;
    }): Promise<Outcome<PatientHit[]>> =>
      guard(
        () => api.POST('/api/v1/patients/search', { params: { header }, body: q }),
        listOf(parsePatientHit),
      ),

    matchPatient: (input: {
      givenName: string;
      familyName: string;
      dateOfBirth: string;
      phone?: string;
      email?: string;
      locationId: string;
    }): Promise<Outcome<MatchResult>> =>
      guard(
        () => api.POST('/api/v1/patients/match', { params: { header }, body: input }),
        parseMatch,
      ),

    register: (
      input: RegisterInput,
      key: string,
    ): Promise<Outcome<{ patientId: string; mrn: string; duplicateFlags: number }>> =>
      guard(
        () =>
          api.POST('/api/v1/patients', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body: {
              givenName: input.givenName,
              familyName: input.familyName,
              dateOfBirth: input.dateOfBirth,
              stateCode: input.stateCode,
              locationId: input.locationId,
              matchCheckId: input.matchCheckId,
              duplicateAcknowledged: input.duplicateAcknowledged ?? false,
              acknowledgeReason: input.acknowledgeReason ?? '',
              ...(input.phone === undefined ? {} : { phone: input.phone }),
              ...(input.email === undefined ? {} : { email: input.email }),
            },
          }),
        (d) => {
          const r = rec(d);
          const patientId = str(r['patientId']);
          const mrn = str(r['mrn']);
          return patientId === undefined || mrn === undefined
            ? undefined
            : {
                patientId,
                mrn,
                duplicateFlags: typeof r['duplicateFlags'] === 'number' ? r['duplicateFlags'] : 0,
              };
        },
      ),

    duplicateFlags: (locationId: string): Promise<Outcome<DuplicateFlag[]>> =>
      guard(
        () =>
          api.GET('/api/v1/duplicate-flags', {
            params: { header, query: { locationId, status: 'open' } },
          }),
        listOf(parseDuplicateFlag),
      ),

    requestMerge: (
      input: { survivorId: string; mergedId: string; reason: string },
      key: string,
    ): Promise<Outcome<{ id: string }>> =>
      guard(
        () =>
          api.POST('/api/v1/patient-merges', {
            params: { header: { ...header, 'Idempotency-Key': key } },
            body: input,
          }),
        (d) => {
          const id = str(rec(d)['id']);
          return id === undefined ? undefined : { id };
        },
      ),

    merge: (id: string): Promise<Outcome<MergeRequest>> =>
      guard(
        () => api.GET('/api/v1/patient-merges/{id}', { params: { header, path: { id } } }),
        parseMerge,
      ),

    decideMerge: (
      id: string,
      decision: 'approve' | 'reject',
      key: string,
    ): Promise<Outcome<MergeRequest>> =>
      guard(
        () =>
          decision === 'approve'
            ? api.POST('/api/v1/patient-merges/{id}/approve', {
                params: { header: { ...header, 'Idempotency-Key': key }, path: { id } },
              })
            : api.POST('/api/v1/patient-merges/{id}/reject', {
                params: { header: { ...header, 'Idempotency-Key': key }, path: { id } },
              }),
        parseMerge,
      ),
  };
}
export type PreconsultApi = ReturnType<typeof createPreconsultApi>;
export { arr };
