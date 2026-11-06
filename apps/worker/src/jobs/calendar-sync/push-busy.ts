// `calendar_sync.push_busy` and `calendar_sync.delete_busy` (ARCHITECTURE 33.1, 25.1; BR-07, BR-23). A confirmed booking becomes a Busy
// event on the doctor's calendar; a cancelled or rescheduled one removes it. The job reads the OCCUPANCY only (a doctor, an interval and
// a status: no patient, no reason, no service) and writes the event title "Busy" with nothing else.
//
// The Google event ID is derived from the occupancy ID and `event_map` records the state, so a retry creates no second event and a
// delete never touches an event that was never created. Both jobs re-read the booking's state after the vendor call: a cancel that raced
// a push removes the event the push has just made.
import { isUuid, eventIdFor } from './ids.js';
import { markLink } from './sync.js';
import type { CalendarJobDeps } from './ports.js';
import { systemScope } from './scope.js';
import { VendorRejectedError } from '../integration-core/errors.js';

export type PushOutcome = 'created' | 'removed' | 'skipped' | 'gone' | 'failed' | 'token_revoked';

const ACTIVE = new Set(['confirmed', 'checked_in', 'in_consultation']);

interface Occ {
  clinicianId: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

async function readOccupancy(deps: CalendarJobDeps, occupancyId: string): Promise<Occ | undefined> {
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT clinician_principal_id, status, lower(period) AS s, upper(period) AS e
         FROM scheduling.slot_occupancy WHERE id = $1::uuid`,
      [occupancyId],
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      clinicianId: String(row.clinician_principal_id),
      status: String(row.status),
      startsAt: (row.s as Date).toISOString(),
      endsAt: (row.e as Date).toISOString(),
    };
  });
}

async function linkOf(
  deps: CalendarJobDeps,
  clinicianId: string,
): Promise<{ calendarId: string } | undefined> {
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT google_calendar_id FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid AND status IN ('active', 'error')`,
      [clinicianId],
    );
    const row = r.rows[0];
    return row === undefined ? undefined : { calendarId: String(row.google_calendar_id) };
  });
}

async function mapOf(
  deps: CalendarJobDeps,
  occupancyId: string,
): Promise<{ clinicianId: string; eventId: string; state: string } | undefined> {
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT clinician_principal_id, google_event_id, state FROM calendar_sync.event_map WHERE occupancy_id = $1::uuid`,
      [occupancyId],
    );
    const row = r.rows[0];
    return row === undefined
      ? undefined
      : {
          clinicianId: String(row.clinician_principal_id),
          eventId: String(row.google_event_id),
          state: String(row.state),
        };
  });
}

async function setState(
  deps: CalendarJobDeps,
  occupancyId: string,
  clinicianId: string,
  eventId: string,
  state: 'pending' | 'created' | 'deleted' | 'failed',
): Promise<void> {
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    await tx.query(
      `INSERT INTO calendar_sync.event_map (occupancy_id, organisation_id, clinician_principal_id, google_event_id, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       ON CONFLICT (occupancy_id) DO UPDATE SET state = EXCLUDED.state`,
      [occupancyId, deps.orgId, clinicianId, eventId, state],
    );
  });
}

/** A permanent refusal is recorded and ends the job (the retries would repeat the same refusal); an outage propagates. */
async function refused(
  deps: CalendarJobDeps,
  err: unknown,
  occupancyId: string,
  clinicianId: string,
  eventId: string,
): Promise<'failed' | 'token_revoked'> {
  if (!(err instanceof VendorRejectedError)) throw err;
  await setState(deps, occupancyId, clinicianId, eventId, 'failed');
  if (err.httpStatus === 401) {
    await markLink(deps, clinicianId, 'token_revoked', 'token_revoked');
    return 'token_revoked';
  }
  return 'failed';
}

async function removeEvent(
  deps: CalendarJobDeps,
  occupancyId: string,
  m: { clinicianId: string; eventId: string },
  calendarId: string,
): Promise<void> {
  await deps.vendor.callVendor(
    'google_calendar',
    'delete_busy',
    { clinicianId: m.clinicianId, calendarId, eventId: m.eventId },
    { type: 'occupancy', id: occupancyId },
  );
  await setState(deps, occupancyId, m.clinicianId, m.eventId, 'deleted');
}

export async function runPushBusy(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<PushOutcome> {
  const raw = payload['occupancyId'];
  if (!isUuid(raw)) throw new Error('calendar_sync.push_busy: occupancyId is required');
  const occupancyId = raw.toLowerCase();
  const occ = await readOccupancy(deps, occupancyId);
  if (occ === undefined) return 'gone';
  if (!ACTIVE.has(occ.status)) return runDeleteBusy(deps, payload); // no longer a booking that blocks time
  const link = await linkOf(deps, occ.clinicianId);
  if (link === undefined) return 'skipped'; // not linked (or token revoked): nothing to push, and nothing is lost
  const eventId = eventIdFor(occupancyId);
  await setState(deps, occupancyId, occ.clinicianId, eventId, 'pending');
  try {
    await deps.vendor.callVendor(
      'google_calendar',
      'push_busy',
      {
        clinicianId: occ.clinicianId,
        calendarId: link.calendarId,
        eventId,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
        occupancyId,
      },
      { type: 'occupancy', id: occupancyId, idempotencyToken: eventId.slice(0, 128) },
    );
  } catch (err) {
    return refused(deps, err, occupancyId, occ.clinicianId, eventId);
  }
  await setState(deps, occupancyId, occ.clinicianId, eventId, 'created');
  // A cancel that raced this push has already found the mapping `pending` and may have run first: look again.
  const after = await readOccupancy(deps, occupancyId);
  if (after === undefined || !ACTIVE.has(after.status)) {
    try {
      await removeEvent(
        deps,
        occupancyId,
        { clinicianId: occ.clinicianId, eventId },
        link.calendarId,
      );
    } catch (err) {
      return refused(deps, err, occupancyId, occ.clinicianId, eventId);
    }
    return 'removed';
  }
  return 'created';
}

export async function runDeleteBusy(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<PushOutcome> {
  const raw = payload['occupancyId'];
  if (!isUuid(raw)) throw new Error('calendar_sync.delete_busy: occupancyId is required');
  const occupancyId = raw.toLowerCase();
  const m = await mapOf(deps, occupancyId);
  if (m === undefined || m.state === 'deleted') return 'skipped'; // never created, or already removed
  const link = await linkOf(deps, m.clinicianId);
  if (link === undefined) {
    // The link is gone: the unlink cleanup (or the revoked grant) is the only thing that can still reach the calendar.
    await setState(deps, occupancyId, m.clinicianId, m.eventId, 'deleted');
    return 'skipped';
  }
  try {
    await removeEvent(deps, occupancyId, m, link.calendarId);
  } catch (err) {
    return refused(deps, err, occupancyId, m.clinicianId, m.eventId);
  }
  return 'removed';
}
