import type { PatientRuntime } from '../../app/runtime.js';
import { asRecord, guard } from '../profile/lib/core.js';
import type { Outcome } from '../profile/lib/core.js';
import { parseThread } from './types.js';
import type { Thread } from './types.js';

export type MessagesApi = ReturnType<typeof createMessagesApi>;

/** Patient messaging (D-5): only while the organisation flag `patient_messaging` is on; otherwise every call is a 404. */
export function createMessagesApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;
  return {
    threads: (patientId: string): Promise<Outcome<Thread[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/threads', {
            params: { header, path: { patientId }, query: {} },
          }),
        (d) => {
          const items = asRecord(d)['items'];
          if (!Array.isArray(items)) return undefined;
          const out = items.map(parseThread);
          return out.every((x) => x !== undefined) ? (out as Thread[]) : undefined;
        },
      ),

    /** Starts a thread with its first message. Recipients are principal ids; the patient cannot pick them yet (README). */
    start: (
      patientId: string,
      body: { subject: string; body: string; recipientPrincipalIds: string[] },
      key: string,
    ): Promise<Outcome<Thread>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/threads', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body,
          }),
        (d) => parseThread(d),
      ),
  };
}
