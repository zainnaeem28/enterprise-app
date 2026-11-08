const part = (iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(iso));

/** "Tue, Jun 2, 9:30 AM EDT": date, time and zone abbreviation of one place (UX-R8, BR-05). */
export const placeLabel = (iso: string, timeZone: string): string =>
  part(iso, timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Both labels when the clinic's time and the patient's own differ; one when they read the same (BR-05). */
export function zoneLabels(
  iso: string,
  clinicZone: string,
  viewer: string = viewerZone(),
): { clinic: string; mine: string | undefined } {
  const clinic = placeLabel(iso, clinicZone);
  const mine = placeLabel(iso, viewer);
  return { clinic, mine: viewer === clinicZone || mine === clinic ? undefined : mine };
}

export const clockIn = (iso: string, timeZone: string): string =>
  part(iso, timeZone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
