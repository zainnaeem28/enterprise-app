// `calendar_sync.unlink_cleanup` (departure D3). Deleting a link leaves behind what the sync made: busy blocks (which would keep blocking
// slots for a calendar nobody reads), push channels (which would keep ringing) and Busy events on the doctor's calendar. This clears them.
// Skipped when the doctor has linked again in the meantime. Stopping channels and deleting events are best effort (the grant may already
// be gone); the database side (blocks, channels, mappings) is always cleared.
import { isUuid } from './ids.js';
import type { CalendarJobDeps } from './ports.js';
import { systemScope } from './scope.js';

export type CleanupOutcome = 'cleaned' | 'relinked';

export async function runUnlinkCleanup(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<CleanupOutcome> {
  const raw = payload['clinicianId'];
  if (!isUuid(raw)) throw new Error('calendar_sync.unlink_cleanup: clinicianId must be a UUID');
  const clinicianId = raw.toLowerCase();
  const scope = systemScope(deps.orgId);
  const state = await deps.db.withScope(scope, async (tx) => {
    const l = await tx.query(
      `SELECT 1 FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid`,
      [clinicianId],
    );
    if (l.rows.length > 0) return undefined;
    const ch = await tx.query(
      `SELECT id, channel_id, resource_id FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1::uuid`,
      [clinicianId],
    );
    const ev = await tx.query(
      `SELECT occupancy_id, google_event_id FROM calendar_sync.event_map WHERE clinician_principal_id = $1::uuid AND state IN ('pending', 'created')`,
      [clinicianId],
    );
    return { channels: ch.rows, events: ev.rows };
  });
  if (state === undefined) return 'relinked';

  for (const c of state.channels) {
    try {
      await deps.vendor.callVendor(
        'google_calendar',
        'stop_watch',
        { clinicianId, channelId: String(c.channel_id), resourceId: String(c.resource_id) },
        { type: 'calendar_link', id: clinicianId },
      );
    } catch {
      /* best effort */
    }
  }
  for (const e of state.events) {
    try {
      await deps.vendor.callVendor(
        'google_calendar',
        'delete_busy',
        { clinicianId, calendarId: 'primary', eventId: String(e.google_event_id) },
        { type: 'occupancy', id: String(e.occupancy_id) },
      );
    } catch {
      /* best effort */
    }
  }
  await deps.db.withScope(scope, async (tx) => {
    // The doctor may have linked again while the vendor calls ran: then nothing of the new link may be touched.
    const l = await tx.query(
      `SELECT 1 FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid`,
      [clinicianId],
    );
    if (l.rows.length > 0) return;
    await tx.query(
      `DELETE FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1::uuid`,
      [clinicianId],
    );
    await tx.query(
      `UPDATE calendar_sync.event_map SET state = 'deleted' WHERE clinician_principal_id = $1::uuid AND state IN ('pending', 'created')`,
      [clinicianId],
    );
    await tx.query(
      `SELECT * FROM scheduling.replace_busy_blocks($1::uuid, '{}'::bytea[], '{}'::tstzrange[])`,
      [clinicianId],
    );
  });
  return 'cleaned';
}
