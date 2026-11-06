// `calendar_sync.incremental_sync` and `calendar_sync.full_resync` (ARCHITECTURE 33.1; the `410 Gone` rule of QA-AL-01 and the null-token
// rule of SAR-IDF-03, both Fixed in draft 8.2). Google is the source; our database holds the doctor's busy intervals, nothing else.
//
// Vendor calls (listing, paging) run OUTSIDE any database transaction. The write is one short transaction that locks the link row, checks
// that the token the listing started from is still the link's (another sync or resync may have won), then replaces the doctor's busy
// blocks through `scheduling.replace_busy_blocks` and stores the new token and `last_synced_at` together.
//
//   incremental_sync, token S:  Google answers `410 Gone` for S  ->  lock the link; `sync_token = NULL` only if it still equals S;
//                               enqueue `full_resync` (key: clinician + SHA-256(S)); change NO busy block.
//   incremental_sync, token null: a full listing is owed, never "wait": call nothing at Google, enqueue `full_resync` with the marker.
//   full_resync:                list with no token, every page; then, in one transaction, stop if a token appeared meanwhile, else replace
//                               the doctor's blocks with the COMPLETE set and store the new token. A failed listing leaves the old blocks
//                               and `last_synced_at` alone (the stale warning shows), retries under the job's attempts, and a job that
//                               went `dead` is enqueued again by the next 15-minute timer run.
//   no clinician in the payload (the timer): one job per active link: `full_resync` where the token is null, else `incremental_sync`.
import type { Tx } from '@ehr/kernel';
import { randomUUID } from 'node:crypto';
import type { BusyChange } from './busy.js';
import { discardedMarker, externalHash, isUuid, sha256 } from './ids.js';
import { nowOf, type CalendarJobDeps } from './ports.js';
import { systemScope } from './scope.js';
import { VendorRejectedError } from '../integration-core/errors.js';

export type SyncOutcome =
  'sweep' | 'skipped' | 'resync_enqueued' | 'synced' | 'superseded' | 'token_revoked' | 'error';

const DAY = 86_400_000;
/** The window of a full listing: a day back (a running meeting), 400 days ahead (the longest booking horizon plus margin). */
export const LIST_PAST_MS = DAY;
export const LIST_FUTURE_MS = 400 * DAY;
const MAX_PAGES = 400;

interface LinkRow {
  calendarId: string;
  status: string;
  syncToken: string | null;
  discardedHash: Buffer | null;
}

async function readLink(tx: Tx, clinicianId: string, lock = false): Promise<LinkRow | undefined> {
  const r = await tx.query(
    `SELECT google_calendar_id, status, sync_token, discarded_token_hash
       FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid ${lock ? 'FOR UPDATE' : ''}`,
    [clinicianId],
  );
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return {
    calendarId: String(row.google_calendar_id),
    status: String(row.status),
    syncToken: (row.sync_token as string | null) ?? null,
    discardedHash: (row.discarded_token_hash as Buffer | null) ?? null,
  };
}

const syncable = (l: LinkRow | undefined): l is LinkRow =>
  l !== undefined && (l.status === 'active' || l.status === 'error');

/** The marker of the full resync a null token owes (SAR-IDF-03): the last discarded token's hash, or `initial`. */
const markerOf = (l: LinkRow): string =>
  l.discardedHash === null ? 'initial' : discardedMarker(l.discardedHash);

async function enqueueResync(
  deps: CalendarJobDeps,
  tx: Tx,
  clinicianId: string,
  marker: string,
): Promise<void> {
  await deps.queue.enqueue(
    tx,
    'calendar_sync.full_resync',
    { clinicianId, marker },
    { jobKey: `resync_${clinicianId}_${marker}` },
  );
}

/** What Google said that is not a retry: 410 (token gone), 401 (grant revoked), anything else it refused. Retryable failures propagate. */
function rejection(
  err: unknown,
): { kind: 'gone' | 'token_revoked' | 'rejected'; status?: number } | undefined {
  if (!(err instanceof VendorRejectedError)) return undefined;
  if (err.httpStatus === 410) return { kind: 'gone' };
  if (err.httpStatus === 401) return { kind: 'token_revoked' };
  return { kind: 'rejected', ...(err.httpStatus === undefined ? {} : { status: err.httpStatus }) };
}

/** The link is broken (token revoked, TC-CAL-06) or refused: visible, not silent. `link_broken` is published once, on the move. */
export async function markLink(
  deps: CalendarJobDeps,
  clinicianId: string,
  status: 'token_revoked' | 'error',
  code: string,
): Promise<void> {
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const cur = await readLink(tx, clinicianId, true);
    if (cur === undefined || cur.status === 'pending_consent') return;
    await tx.query(
      `UPDATE calendar_sync.calendar_link SET status = $2, last_error_code = $3 WHERE clinician_principal_id = $1::uuid`,
      [clinicianId, status, code],
    );
    if (status === 'token_revoked' && cur.status !== 'token_revoked')
      await deps.queue.publish(tx, 'calendar_sync.link_broken', {
        eventId: randomUUID(),
        organisationId: deps.orgId,
        clinicianId,
        reason: 'token_revoked',
      });
  });
}

async function listAll(
  deps: CalendarJobDeps,
  clinicianId: string,
  calendarId: string,
  syncToken: string | undefined,
): Promise<{ changes: Map<string, BusyChange>; nextSyncToken: string }> {
  const now = nowOf(deps).getTime();
  const changes = new Map<string, BusyChange>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await deps.vendor.callVendor(
      'google_calendar',
      'incremental_sync',
      {
        clinicianId,
        calendarId,
        ...(syncToken === undefined
          ? {
              timeMin: new Date(now - LIST_PAST_MS).toISOString(),
              timeMax: new Date(now + LIST_FUTURE_MS).toISOString(),
            }
          : { syncToken }),
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      { type: 'calendar_link', id: clinicianId },
    );
    const d = res.data as {
      changes?: BusyChange[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    for (const c of d.changes ?? []) changes.set(c.eventId, c);
    if (d.nextPageToken !== undefined) {
      pageToken = d.nextPageToken;
      continue;
    }
    if (d.nextSyncToken === undefined)
      throw new Error('calendar_sync: the listing ended without a sync token'); // retried under the job's attempts
    return { changes, nextSyncToken: d.nextSyncToken };
  }
  throw new Error('calendar_sync: the listing has too many pages');
}

/**
 * The one write: lock the link, require that its token is still the one the listing began from, replace the doctor's blocks through
 * `scheduling.replace_busy_blocks` and store the new token. `merge` applies a delta to the current rows (incremental); `replace`
 * makes the listing the whole set (full resync).
 */
async function write(
  deps: CalendarJobDeps,
  clinicianId: string,
  expected: string | null,
  next: string,
  changes: ReadonlyMap<string, BusyChange>,
  mode: 'merge' | 'replace',
): Promise<'written' | 'superseded'> {
  const cutoff = nowOf(deps).getTime() - LIST_PAST_MS;
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const link = await readLink(tx, clinicianId, true);
    if (!syncable(link) || link.syncToken !== expected) return 'superseded';
    const set = new Map<string, { hash: Buffer; startsAt: string; endsAt: string }>();
    if (mode === 'merge') {
      const cur = await tx.query(
        `SELECT external_hash, lower(period) AS s, upper(period) AS e
           FROM scheduling.busy_block WHERE clinician_principal_id = $1::uuid AND source = 'google'`,
        [clinicianId],
      );
      for (const r of cur.rows) {
        const hash = r.external_hash as Buffer;
        set.set(hash.toString('hex'), {
          hash,
          startsAt: (r.s as Date).toISOString(),
          endsAt: (r.e as Date).toISOString(),
        });
      }
    }
    for (const c of changes.values()) {
      const hash = externalHash(c.eventId);
      if (c.busy === null) set.delete(hash.toString('hex'));
      else set.set(hash.toString('hex'), { hash, ...c.busy });
    }
    const blocks = [...set.values()].filter((b) => Date.parse(b.endsAt) >= cutoff);
    await tx.query(
      `SELECT * FROM scheduling.replace_busy_blocks($1::uuid, $2::bytea[], $3::tstzrange[])`,
      [clinicianId, blocks.map((b) => b.hash), blocks.map((b) => `[${b.startsAt},${b.endsAt})`)],
    );
    await tx.query(
      `UPDATE calendar_sync.calendar_link
          SET sync_token = $2, last_synced_at = now(), last_error_code = NULL, status = 'active'
        WHERE clinician_principal_id = $1::uuid`,
      [clinicianId, next],
    );
    return 'written';
  });
}

/** Step 1 of the 410 rule. */
async function discardToken(
  deps: CalendarJobDeps,
  clinicianId: string,
  token: string,
): Promise<void> {
  const hash = sha256(token);
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const link = await readLink(tx, clinicianId, true);
    if (link === undefined) return;
    await tx.query(
      `UPDATE calendar_sync.calendar_link SET sync_token = NULL, discarded_token_hash = $3
        WHERE clinician_principal_id = $1::uuid AND sync_token = $2`,
      [clinicianId, token, hash],
    );
    await enqueueResync(deps, tx, clinicianId, discardedMarker(hash));
  });
}

async function sweep(deps: CalendarJobDeps): Promise<void> {
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT clinician_principal_id, sync_token IS NULL AS owes, discarded_token_hash
         FROM calendar_sync.calendar_link WHERE status IN ('active', 'error') ORDER BY clinician_principal_id`,
    );
    for (const row of r.rows) {
      const id = String(row.clinician_principal_id);
      if (row.owes === true) {
        const h = row.discarded_token_hash as Buffer | null;
        await enqueueResync(deps, tx, id, h === null ? 'initial' : discardedMarker(h));
      } else {
        await deps.queue.enqueue(
          tx,
          'calendar_sync.incremental_sync',
          { clinicianId: id },
          { jobKey: `inc_${id}` },
        );
      }
    }
  });
}

export async function runIncrementalSync(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<SyncOutcome> {
  const raw = payload['clinicianId'];
  if (raw === undefined) {
    await sweep(deps);
    return 'sweep';
  }
  if (!isUuid(raw)) throw new Error('calendar_sync.incremental_sync: clinicianId must be a UUID');
  const clinicianId = raw.toLowerCase();
  const link = await deps.db.withScope(systemScope(deps.orgId), (tx) => readLink(tx, clinicianId));
  if (!syncable(link)) return 'skipped';
  if (link.syncToken === null) {
    // A null token owes a full listing; nothing is called at Google.
    await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      enqueueResync(deps, tx, clinicianId, markerOf(link)),
    );
    return 'resync_enqueued';
  }
  const token = link.syncToken;
  let listed;
  try {
    listed = await listAll(deps, clinicianId, link.calendarId, token);
  } catch (err) {
    const rej = rejection(err);
    if (rej === undefined) throw err; // unavailable: the queue retries with back-off
    if (rej.kind === 'gone') {
      await discardToken(deps, clinicianId, token);
      return 'resync_enqueued';
    }
    if (rej.kind === 'token_revoked') {
      await markLink(deps, clinicianId, 'token_revoked', 'token_revoked');
      return 'token_revoked';
    }
    await markLink(deps, clinicianId, 'error', `vendor_rejected_${rej.status ?? 0}`);
    return 'error';
  }
  return (await write(deps, clinicianId, token, listed.nextSyncToken, listed.changes, 'merge')) ===
    'written'
    ? 'synced'
    : 'superseded';
}

export async function runFullResync(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<SyncOutcome> {
  const raw = payload['clinicianId'];
  const marker = payload['marker'];
  if (!isUuid(raw) || typeof marker !== 'string')
    throw new Error('calendar_sync.full_resync: clinicianId and marker are required');
  const clinicianId = raw.toLowerCase();
  const link = await deps.db.withScope(systemScope(deps.orgId), (tx) => readLink(tx, clinicianId));
  if (!syncable(link)) return 'skipped';
  if (link.syncToken !== null) return 'superseded'; // another resync won before this one started
  let listed;
  try {
    listed = await listAll(deps, clinicianId, link.calendarId, undefined);
  } catch (err) {
    const rej = rejection(err);
    if (rej === undefined) throw err; // the old blocks stay; last_synced_at does not move; the job retries
    if (rej.kind === 'token_revoked') {
      await markLink(deps, clinicianId, 'token_revoked', 'token_revoked');
      return 'token_revoked';
    }
    await markLink(deps, clinicianId, 'error', `vendor_rejected_${rej.status ?? 0}`);
    return 'error';
  }
  const done = await write(
    deps,
    clinicianId,
    null,
    listed.nextSyncToken,
    listed.changes,
    'replace',
  );
  if (done === 'superseded') return 'superseded';
  if (marker === 'initial') await backfillBookings(deps, clinicianId);
  return 'synced';
}

/** A new link starts with the bookings that already exist: each upcoming active booking without a Busy event gets one pushed. */
async function backfillBookings(deps: CalendarJobDeps, clinicianId: string): Promise<void> {
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT o.id FROM scheduling.slot_occupancy o
        WHERE o.clinician_principal_id = $1::uuid AND o.status IN ('confirmed', 'checked_in', 'in_consultation')
          AND upper(o.period) > now()
          AND NOT EXISTS (SELECT 1 FROM calendar_sync.event_map m WHERE m.occupancy_id = o.id AND m.state = 'created')
        ORDER BY lower(o.period) LIMIT 2000`,
      [clinicianId],
    );
    for (const row of r.rows) {
      const id = String(row.id);
      await deps.queue.enqueue(
        tx,
        'calendar_sync.push_busy',
        { occupancyId: id },
        { jobKey: `push_${id}` },
      );
    }
  });
}
