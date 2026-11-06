// `telehealth.create_meeting` (ARCHITECTURE 33.1, 34.3; `on_merged = resolve`): the vendor room of a video visit, made ahead of time.
//
//   1. a patients-scope transaction makes sure the session row exists and reads whether it already has a room;
//   2. the vendor is asked OUTSIDE any transaction (`callVendor`: log, retry and circuit are the gateway's). The call carries our
//      idempotency token (derived from the session, identical on every retry) and `recording: false` (SEC-D-14);
//   3. a patients-scope transaction records the room once.
// A vendor failure is rethrown so the queue retries the whole job (8 attempts). If the room exists at the vendor and step 3 fails, the
// retry gets the same room back from the vendor (token or correlation lookup), so a retry never makes a second one.
import { randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import { asPatient } from './on-reservation-confirmed.js';
import type { TelehealthJobDeps } from './ports.js';
import { patientsScope } from './scope.js';

export type MeetingOutcome = 'created' | 'exists' | 'skipped' | 'gone';

const MEETING_ID = /^[\x21-\x7e]{1,200}$/;
const VENDOR = /^[a-z][a-z0-9_]{0,39}$/;

export async function runCreateMeeting(
  deps: TelehealthJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'telehealth.create_meeting',
): Promise<MeetingOutcome> {
  const reservationId = payload['reservationId'];
  const patientId = payload['patientId'];
  if (!isUuid(reservationId) || !isUuid(patientId))
    throw new Error('telehealth.create_meeting: reservationId and patientId are required');
  const rid = reservationId.toLowerCase();
  const meta = { requestId: null, jobId: jobRef.slice(0, 200) };

  let scope = patientId.toLowerCase();
  let sessionId: string | undefined;
  const first = await asPatient<MeetingOutcome | 'make'>(deps, scope, async (pid) => {
    scope = pid;
    return deps.db.withScope(patientsScope(deps.orgId, [pid]), async (tx) => {
      const r = await deps.telehealth.ensureSession(tx, meta, rid);
      if (r.outcome === 'gone') return 'gone';
      if (r.outcome === 'skipped') return 'skipped';
      sessionId = r.sessionId;
      return r.hasMeeting ? 'exists' : 'make';
    });
  });
  if (first !== 'make') return first;
  if (sessionId === undefined) return 'gone';

  const res = await deps.vendor.callVendor(
    'video',
    'create_meeting',
    { externalId: sessionId, recording: false },
    { type: 'telehealth.session', id: sessionId, idempotencyToken: `tm-${sessionId}` },
  );
  const data = res.data as { meetingId?: unknown; vendor?: unknown } | null;
  if (
    data === null ||
    typeof data !== 'object' ||
    typeof data.meetingId !== 'string' ||
    !MEETING_ID.test(data.meetingId) ||
    typeof data.vendor !== 'string' ||
    !VENDOR.test(data.vendor)
  )
    throw new Error('telehealth.create_meeting: the video adapter answered with an unusable room');

  const recorded = await deps.db.withScope(patientsScope(deps.orgId, [scope]), (tx) =>
    deps.telehealth.recordMeeting(
      tx,
      { requestId: null, jobId: `${jobRef}:${randomUUID()}`.slice(0, 200) },
      sessionId as string,
      data.vendor as string,
      data.meetingId as string,
    ),
  );
  // Not recorded = the session is not this patient's any more (a merge between the steps): the retry finds the survivor.
  if (!recorded) throw new Error('telehealth.create_meeting: the session moved; retry');
  return 'created';
}
