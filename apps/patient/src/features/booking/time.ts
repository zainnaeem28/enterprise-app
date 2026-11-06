import type { Appointment } from './types.js';

const zoneLabel = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(iso))
    .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;

/** "Tue, Jun 2" in the place's zone (UX-R8). */
export function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

/** "9:30 AM" in the place's zone. */
export function clockLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/** "Tue, Jun 2, 9:30 AM ET": date, time and the zone label of the place (UX-R8, BR-05). */
export function whenLabel(iso: string, timeZone: string): string {
  return `${dayLabel(iso, timeZone)}, ${clockLabel(iso, timeZone)} ${zoneLabel(iso, timeZone)}`;
}

export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** For a video visit both zones are shown when they differ; otherwise the one label. */
export function whenLabels(
  iso: string,
  placeZone: string,
  video: boolean,
  viewer: string = viewerZone(),
): string[] {
  const place = whenLabel(iso, placeZone);
  if (!video || viewer === placeZone) return [place];
  const mine = whenLabel(iso, viewer);
  return mine === place ? [place] : [place, mine];
}

export const appointmentWhen = (a: Appointment): string[] =>
  whenLabels(a.startsAt, a.locationTimeZone, a.mode === 'video');

/** Calendar-day key (yyyy-mm-dd) of an instant in a zone, used to group slots under a day heading. */
export function dayKey(iso: string, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return p;
}

/** Seconds left on a hold from the server expiry and the server-clock offset; never negative. */
export function secondsLeft(expiresAt: string, clockOffsetMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - (now + clockOffsetMs)) / 1000));
}

export function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
