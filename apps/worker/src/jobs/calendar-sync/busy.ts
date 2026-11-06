// From a Google event to "is this doctor busy, and when" (ARCHITECTURE 33.1 "standard busy-time query and filtering", BR-07).
// The adapter asks Google for no title, description, attendee name or location (the `fields` mask), and this function keeps only an
// event ID and an interval, so a meeting's content never reaches a job result, a log or the database.
//
// Busy = an event that shows the doctor as busy: not cancelled, not marked "free" (transparent), not declined by the doctor, not one
// of OUR Busy events (those already exist as booked occupancy; counting them would make a slot block itself). Tentative counts as busy.
// An all-day event blocks the whole local day(s) in the event's own time zone, else the calendar's.
export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEventLite {
  id?: string;
  status?: string;
  transparency?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  extendedProperties?: { private?: Record<string, string> };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** `busy: null` means "this event is not busy time (any more)": remove its block if there is one. */
export interface BusyChange {
  eventId: string;
  busy: { startsAt: string; endsAt: string } | null;
}

/** Marker our own Busy events carry (private extended property; no patient, no occupancy detail). */
export const OWN_EVENT_KEY = 'ehrBusy';
const MAX_SPAN_MS = 399 * 86_400_000;

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

/** The instant a calendar date starts in a time zone (daylight saving is the platform's, not ours). Unknown zones fall back to UTC. */
export function startOfDayIn(date: string, timeZone: string | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return undefined;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess)) return undefined;
  let zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const first = guess - tzOffsetMs(guess, zone);
  return guess - tzOffsetMs(first, zone); // second pass settles the offset across a transition
}

function instant(t: GoogleTime | undefined, calendarZone: string | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (typeof t.dateTime === 'string') {
    const ms = Date.parse(t.dateTime);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof t.date === 'string') return startOfDayIn(t.date, t.timeZone ?? calendarZone);
  return undefined;
}

export function toBusyChange(e: GoogleEventLite, calendarZone?: string): BusyChange | undefined {
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 1024) return undefined;
  const none: BusyChange = { eventId: e.id, busy: null };
  if (e.status === 'cancelled') return none;
  if (e.transparency === 'transparent') return none;
  if (e.extendedProperties?.private?.[OWN_EVENT_KEY] === '1') return none;
  if (e.attendees?.some((a) => a.self === true && a.responseStatus === 'declined') === true) return none;
  const start = instant(e.start, calendarZone);
  const end = instant(e.end, calendarZone);
  if (start === undefined || end === undefined || end <= start) return none;
  const clippedEnd = Math.min(end, start + MAX_SPAN_MS);
  return {
    eventId: e.id,
    busy: { startsAt: new Date(start).toISOString(), endsAt: new Date(clippedEnd).toISOString() },
  };
}
