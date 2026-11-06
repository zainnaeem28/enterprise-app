// The inbound handler of a Google Calendar push (ARCHITECTURE 25.7, 29.5; DF-3). Registered with integration-core's dispatch for
// source `google_calendar`, message type `google_calendar.push`.
//
// The API has already verified the channel token, but a compromised API could store a forged message, so this handler treats the payload
// as untrusted input (DF-3): it validates the shape strictly, and it causes no privileged side effect without a second check. It matches
// the channel ID AND resource ID against an unexpired `watch_channel` row, and ignores (the message is marked handled) any that do not. A
// real push only starts an idempotent incremental sync that reads from Google; the push body is never the source of a change.
import { isUuid } from './ids.js';
import type { InboundHandlerFn, InboundHandlerRegistry } from '../integration-core/dispatch.js';
import { nowOf, type CalendarJobDeps } from './ports.js';
import { systemScope } from './scope.js';

export const GOOGLE_CALENDAR_SOURCE = 'google_calendar';
export const GOOGLE_PUSH_MESSAGE_TYPE = 'google_calendar.push';

export type PushOutcome = 'enqueued' | 'ignored';

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function parsePush(body: Buffer): { channelId: string; resourceId: string; state: string } | undefined {
  if (body.length === 0 || body.length > 1024) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 3 || !['channelId', 'resourceId', 'resourceState'].every((k) => keys.includes(k))) return undefined;
  const { channelId, resourceId, resourceState } = o;
  if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return undefined;
  if (typeof resourceId !== 'string' || !RESOURCE_ID.test(resourceId)) return undefined;
  if (resourceState !== 'sync' && resourceState !== 'exists' && resourceState !== 'not_exists') return undefined;
  return { channelId, resourceId, state: resourceState };
}

export async function handlePush(deps: CalendarJobDeps, body: Buffer): Promise<PushOutcome> {
  const push = parsePush(body);
  if (push === undefined) return 'ignored';
  // `sync` is Google's "channel established" message: nothing has changed.
  if (push.state === 'sync') return 'ignored';
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = await tx.query(
      `SELECT w.clinician_principal_id
         FROM calendar_sync.watch_channel w
         JOIN calendar_sync.calendar_link l ON l.clinician_principal_id = w.clinician_principal_id
        WHERE w.channel_id = $1 AND w.resource_id = $2 AND w.expires_at > $3::timestamptz AND l.status IN ('active', 'error')`,
      [push.channelId, push.resourceId, nowOf(deps).toISOString()],
    );
    const id = r.rows[0]?.clinician_principal_id as string | undefined;
    if (id === undefined || !isUuid(id)) return 'ignored' as const;
    // One job per doctor (the key replaces one that has not started), so a burst of pushes is one sync.
    await deps.queue.enqueue(tx, 'calendar_sync.incremental_sync', { clinicianId: id }, { jobKey: `inc_${id}` });
    return 'enqueued' as const;
  });
}

export function registerGooglePushHandler(registry: InboundHandlerRegistry, deps: CalendarJobDeps): void {
  const fn: InboundHandlerFn = async (msg) => {
    await handlePush(deps, msg.body);
  };
  registry.register(GOOGLE_CALENDAR_SOURCE, GOOGLE_PUSH_MESSAGE_TYPE, 'calendar_sync.on_push', fn);
}
