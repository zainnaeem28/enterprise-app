import type { DayVisit, Rule, Template } from './types.js';

/** Statuses of a visit that a change of hours can strand. A completed, cancelled or no-show visit is history. */
const LIVE = new Set(['held', 'confirmed', 'checked_in', 'in_consultation']);

const parts = (iso: string, timeZone: string) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p['weekday'] ?? '');
  return {
    date: `${p['year']}-${p['month']}-${p['day']}`,
    weekday,
    minutes: Number(p['hour']) * 60 + Number(p['minute']),
  };
};

/** The local date (`YYYY-MM-DD`) at a time zone, `days` after the given instant. */
export function localDate(now: Date, timeZone: string, days = 0): string {
  const d = parts(now.toISOString(), timeZone).date;
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const minutesOf = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const covered = (
  templates: readonly Pick<Template, 'validFrom' | 'validTo' | 'rules'>[],
  v: DayVisit,
  timeZone: string,
): boolean => {
  const s = parts(v.startsAt, timeZone);
  const e = parts(v.endsAt, timeZone);
  return templates.some(
    (t) =>
      s.date >= t.validFrom &&
      (t.validTo === null || s.date <= t.validTo) &&
      t.rules.some(
        (r: Rule) =>
          r.weekday === s.weekday &&
          minutesOf(r.startLocal) <= s.minutes &&
          // a visit that ends at local midnight ends at "24:00" of its own day
          (e.date !== s.date ? 24 * 60 : e.minutes) <= minutesOf(r.endLocal),
      ),
  );
};

/**
 * Live visits that the current templates cover and the changed set would not: what a save of the hours would leave outside them.
 * Nothing is cancelled by a save (the server does not touch appointments); this is what the doctor is asked to acknowledge.
 */
export function strandedVisits(
  before: readonly Pick<Template, 'validFrom' | 'validTo' | 'rules'>[],
  after: readonly Pick<Template, 'validFrom' | 'validTo' | 'rules'>[],
  visits: readonly DayVisit[],
  timeZone: string,
): DayVisit[] {
  return visits.filter(
    (v) => LIVE.has(v.status) && covered(before, v, timeZone) && !covered(after, v, timeZone),
  );
}
