// `calendar_sync.renew_watch` (ARCHITECTURE 33.1, 29.5). Registers a Google push channel for a linked doctor, with the HMAC channel token
//   v.<key version>.<expiry epoch>.<base64url(HMAC-SHA256(channel key, channel_id "." expiry))>
// under the CURRENT key version. The API verifies the token without reading `watch_channel` (TDR-05), so no token and no token hash
// is stored here: only the channel and resource IDs (to match a push to a doctor), the key version (to renew after a rotation) and
// the expiry. The embedded expiry never lies more than 7 days ahead (the verifier refuses a longer one) and is not later than the
// channel's own expiry.
//
// Payload: `{clinicianId}` renews one doctor. No clinician (the daily timer) is the sweep: a doctor needs a new channel when none has more
// than 36 hours left or the only one was signed with an older key version. A new channel is registered BEFORE the old one is stopped, so
// no push is missed; expired rows are dropped.
import { createHmac, randomUUID } from 'node:crypto';
import { isUuid } from './ids.js';
import { markLink } from './sync.js';
import { nowOf, type CalendarJobDeps } from './ports.js';
import { systemScope } from './scope.js';
import { VendorRejectedError } from '../integration-core/errors.js';

const HOUR = 3_600_000;
/** Inside the verifier's 7-day ceiling with margin for clock difference. */
export const CHANNEL_LIFETIME_MS = 7 * 24 * HOUR - HOUR;
export const RENEW_BEFORE_MS = 36 * HOUR;

/** The token the worker sets (29.5). Same format as the API verifier's `googleChannelToken`; a cross-package test pins them together. */
export function channelToken(
  key: { version: string; key: Buffer },
  channelId: string,
  expiryEpoch: number,
): string {
  const mac = createHmac('sha256', key.key).update(`${channelId}.${expiryEpoch}`).digest('base64url');
  return `v.${key.version}.${expiryEpoch}.${mac}`;
}

export type RenewOutcome = 'sweep' | 'renewed' | 'skipped' | 'token_revoked' | 'failed';

async function sweep(deps: CalendarJobDeps): Promise<void> {
  const cur = await deps.channelKeys.current();
  const horizon = new Date(nowOf(deps).getTime() + RENEW_BEFORE_MS);
  await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    await tx.query(`DELETE FROM calendar_sync.watch_channel WHERE expires_at < $1::timestamptz`, [
      nowOf(deps).toISOString(),
    ]);
    const r = await tx.query(
      `SELECT l.clinician_principal_id
         FROM calendar_sync.calendar_link l
        WHERE l.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM calendar_sync.watch_channel w
                           WHERE w.clinician_principal_id = l.clinician_principal_id
                             AND w.expires_at > $1::timestamptz AND w.token_key_version = $2)
        ORDER BY l.clinician_principal_id`,
      [horizon.toISOString(), cur.version],
    );
    for (const row of r.rows) {
      const id = String(row.clinician_principal_id);
      await deps.queue.enqueue(tx, 'calendar_sync.renew_watch', { clinicianId: id }, { jobKey: `renew_${id}` });
    }
  });
}

export async function runRenewWatch(
  deps: CalendarJobDeps,
  payload: Record<string, unknown>,
): Promise<RenewOutcome> {
  const raw = payload['clinicianId'];
  if (raw === undefined) {
    await sweep(deps);
    return 'sweep';
  }
  if (!isUuid(raw)) throw new Error('calendar_sync.renew_watch: clinicianId must be a UUID');
  const clinicianId = raw.toLowerCase();
  const link = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT google_calendar_id FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid AND status = 'active'`,
      [clinicianId],
    );
    return r.rows[0] === undefined ? undefined : String(r.rows[0].google_calendar_id);
  });
  if (link === undefined) return 'skipped';

  const key = await deps.channelKeys.current();
  const expiresAtMs = nowOf(deps).getTime() + CHANNEL_LIFETIME_MS;
  const channelId = randomUUID();
  let registered: { resourceId: string; expiresAtMs?: number };
  try {
    const res = await deps.vendor.callVendor(
      'google_calendar',
      'watch',
      {
        clinicianId,
        calendarId: link,
        channelId,
        token: channelToken(key, channelId, Math.floor(expiresAtMs / 1000)),
        address: deps.webhookUrl,
        expiresAtMs,
      },
      { type: 'calendar_link', id: clinicianId },
    );
    registered = res.data as { resourceId: string; expiresAtMs?: number };
  } catch (err) {
    if (!(err instanceof VendorRejectedError)) throw err;
    if (err.httpStatus === 401) {
      await markLink(deps, clinicianId, 'token_revoked', 'token_revoked');
      return 'token_revoked';
    }
    return 'failed'; // a permanent refusal: the 15-minute poll keeps the calendar current without a channel
  }
  const effective = Math.min(expiresAtMs, registered.expiresAtMs ?? expiresAtMs);
  const old = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const prev = await tx.query(
      `SELECT id, channel_id, resource_id FROM calendar_sync.watch_channel WHERE clinician_principal_id = $1::uuid`,
      [clinicianId],
    );
    await tx.query(
      `INSERT INTO calendar_sync.watch_channel (id, organisation_id, clinician_principal_id, channel_id, resource_id, token_key_version, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz)`,
      [randomUUID(), deps.orgId, clinicianId, channelId, registered.resourceId, key.version, new Date(effective).toISOString()],
    );
    return prev.rows.map((r) => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      resourceId: String(r.resource_id),
    }));
  });
  for (const o of old) {
    try {
      await deps.vendor.callVendor(
        'google_calendar',
        'stop_watch',
        { clinicianId, channelId: o.channelId, resourceId: o.resourceId },
        { type: 'calendar_link', id: clinicianId },
      );
    } catch (err) {
      // Best effort: the old channel dies at its own expiry, and its row is dropped by the next sweep.
      deps.log.warn('calendar_sync: stopping an old channel failed', { reason: err instanceof Error ? err.name : 'unknown' });
      continue;
    }
    await deps.db.withScope(systemScope(deps.orgId), (tx) =>
      tx.query(`DELETE FROM calendar_sync.watch_channel WHERE id = $1::uuid`, [o.id]).then(() => undefined),
    );
  }
  return 'renewed';
}
