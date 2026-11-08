import type { PatientRuntime } from '../../app/runtime.js';
import { asRecord, failureOf, guard, newKey, str } from '../profile/lib/core.js';
import type { Failure, Outcome } from '../profile/lib/core.js';
import { parseGrant, parseSession } from './types.js';
import type { DeviceCheck, JoinGrant, SessionView } from './types.js';

export type TelehealthApi = ReturnType<typeof createTelehealthApi>;

/** A join that did not give a token: the person is in the waiting room, or it is too early (the API says when). */
export type JoinOutcome =
  | { kind: 'granted'; grant: JoinGrant }
  | { kind: 'waiting' }
  | { kind: 'early'; opensAt: string }
  | { kind: 'location_required' }
  | { kind: 'refused'; failure: Failure };

export { newKey };

export function createTelehealthApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;

  return {
    /** Passive poll (26.2): does not extend the session. */
    session: (reservationId: string): Promise<Outcome<SessionView>> =>
      guard(
        () =>
          api.GET('/api/v1/appointments/{reservationId}/video-session', {
            params: { header, path: { reservationId } },
          }),
        (d) => parseSession(d),
      ),

    deviceCheck: (reservationId: string, check: DeviceCheck): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/video-session/device-check', {
            params: { header, path: { reservationId } },
            body: { ...check },
          }),
        () => true as const,
      ),

    /** The answer is kept by the server even when it is a refusal; a repeat is a new attempt. */
    confirmLocation: (reservationId: string, state: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/video-session/location', {
            params: {
              header: { ...header, 'Idempotency-Key': newKey() },
              path: { reservationId },
            },
            body: { state },
          }),
        () => true as const,
      ),

    /** Asks to join. The waiting room is entered by this call; the token comes only once the host has admitted the person. */
    join: async (reservationId: string): Promise<JoinOutcome> => {
      try {
        const { data, error, response } = await api.POST(
          '/api/v1/appointments/{reservationId}/video-session/join',
          {
            params: {
              header: { ...header, 'Idempotency-Key': newKey() },
              path: { reservationId },
            },
          },
        );
        if (response.ok) {
          const grant = parseGrant(data);
          return grant === undefined
            ? { kind: 'refused', failure: failureOf(response, undefined) }
            : { kind: 'granted', grant };
        }
        const f = failureOf(response, error);
        if (f.code === 'telehealth.not_admitted') {
          const early = (
            Array.isArray(asRecord(error)['errors']) ? (asRecord(error)['errors'] as unknown[]) : []
          )
            .map(asRecord)
            .find((e) => e['path'] === '/joinOpensAt');
          const at = str(early?.['code']);
          return at === undefined ? { kind: 'waiting' } : { kind: 'early', opensAt: at };
        }
        if (f.code === 'telehealth.location_required') return { kind: 'location_required' };
        return { kind: 'refused', failure: f };
      } catch {
        return {
          kind: 'refused',
          failure: { ok: false, status: 0, code: 'kernel.unavailable', fields: [] },
        };
      }
    },
  };
}
