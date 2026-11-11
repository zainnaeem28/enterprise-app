// Pure rules of the telehealth module: nothing here touches the database, so each can be tested alone.
import type { DeviceCheck, DeviceVerdict } from './types.js';

/** The join window opens this long before the start (TC-TH-05) and closes for a patient at the end of the slot. */
export const JOIN_OPENS_MINUTES = 10;
/** The vendor room is created this long before the start at the latest (33.1 `telehealth.create_meeting`). */
export const MEETING_LEAD_MINUTES = 15;
/** A stale session is ended this long after the end of its slot (33.1 `telehealth.end_stale`). */
export const STALE_AFTER_HOURS = 2;
/** `telehealth.close_meeting`: the vendor room is closed this long after the end of its slot at the latest (the join window closes). */
export const CLOSE_AFTER_MINUTES = 30;
/** The lifetime of a join token record and of the vendor token asked for (the table caps it at 15 minutes). */
export const TOKEN_TTL_SECONDS = 300;
/** A confirmation of location is good for this long (a visit never lasts that long; a new day needs a new answer). */
export const LOCATION_VALID_HOURS = 12;

const MIN = 60_000;
export const joinOpensAt = (startsAt: Date, openMinutes = JOIN_OPENS_MINUTES): Date =>
  new Date(startsAt.getTime() - openMinutes * MIN);

export const meetingDueAt = (startsAt: Date, now: Date): Date =>
  new Date(Math.max(now.getTime(), startsAt.getTime() - MEETING_LEAD_MINUTES * MIN));

export type WindowState = 'early' | 'open' | 'closed';
/** A patient's window: early before it opens, closed from the end of the slot. */
export function patientWindow(
  now: Date,
  startsAt: Date,
  endsAt: Date,
  openMinutes?: number,
): WindowState {
  if (now.getTime() < joinOpensAt(startsAt, openMinutes).getTime()) return 'early';
  if (now.getTime() >= endsAt.getTime()) return 'closed';
  return 'open';
}

/** A host's window: not before it opens; it stays open until the session is ended. */
export const hostWindow = (now: Date, startsAt: Date, openMinutes?: number): WindowState =>
  now.getTime() < joinOpensAt(startsAt, openMinutes).getTime() ? 'early' : 'open';

export const isStale = (now: Date, endsAt: Date, hours = STALE_AFTER_HOURS): boolean =>
  now.getTime() >= endsAt.getTime() + hours * 60 * MIN;

/** Two letters, any case, as typed in a form; the stored form is upper case. Anything else is not a state code. */
export function normaliseState(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : undefined;
}

const VERDICTS: readonly DeviceVerdict[] = ['pass', 'fail'];

/** Camera, microphone and bandwidth, each `pass` or `fail`, and nothing else (22.10): an extra key is refused, not dropped. */
export function parseDeviceCheck(v: unknown): DeviceCheck | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 3 || keys[0] !== 'bandwidth' || keys[1] !== 'camera' || keys[2] !== 'mic')
    return undefined;
  const ok = (x: unknown): x is DeviceVerdict => VERDICTS.includes(x as DeviceVerdict);
  if (!ok(o['camera']) || !ok(o['mic']) || !ok(o['bandwidth'])) return undefined;
  return { camera: o['camera'], mic: o['mic'], bandwidth: o['bandwidth'] };
}
