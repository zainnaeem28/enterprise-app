import { useCallback, useRef, useState } from 'react';
import type { AvailabilityApi } from './api.js';
import { localDate, strandedVisits } from './affected.js';
import type { DayVisit, Template } from './types.js';

export const PREVIEW_DAYS = 14;

export type Preview =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'failed' }
  | { kind: 'ready'; stranded: { date: string; visit: DayVisit }[]; timeZone: string };

export type Hours = Pick<Template, 'validFrom' | 'validTo' | 'rules'>;

/**
 * Weekly hours have no server-side conflict report (only leave and blocked time do, 29.3), so the screen computes it from the
 * doctor's own visits at the location for the next `PREVIEW_DAYS` days: the visits the current hours cover and the changed hours
 * would not. Any day that cannot be read fails the whole check, so a save is never offered on a partial answer.
 */
export function usePreview(api: AvailabilityApi, clinicianId: string, locationId: string) {
  const [state, setState] = useState<Preview>({ kind: 'idle' });
  const latest = useRef(0);

  const check = useCallback(
    async (before: readonly Hours[], after: readonly Hours[], now: Date = new Date()) => {
      const mine = ++latest.current;
      setState({ kind: 'checking' });
      // Today first: its answer names the location's time zone, which decides what "tomorrow" is there.
      const today = await api.day(clinicianId, locationId);
      if (!today.ok) return mine === latest.current ? setState({ kind: 'failed' }) : undefined;
      const tz = today.data.timeZone;
      const days = Array.from({ length: PREVIEW_DAYS - 1 }, (_, i) => localDate(now, tz, i + 1));
      const rest = await Promise.all(days.map((d) => api.day(clinicianId, locationId, d)));
      if (mine !== latest.current) return undefined;
      if (rest.some((r) => !r.ok)) return setState({ kind: 'failed' });
      const all = [
        { date: localDate(now, tz), visits: today.data.items },
        ...rest.map((r, i) => ({
          date: days[i] as string,
          visits: r.ok ? r.data.items : [],
        })),
      ];
      const stranded = all.flatMap(({ date, visits }) =>
        strandedVisits(before, after, visits, tz).map((visit) => ({ date, visit })),
      );
      return setState({ kind: 'ready', stranded, timeZone: tz });
    },
    [api, clinicianId, locationId],
  );
  const reset = useCallback(() => {
    latest.current++;
    setState({ kind: 'idle' });
  }, []);
  return { state, check, reset };
}
