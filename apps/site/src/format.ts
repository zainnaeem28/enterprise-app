/** "Tue, Nov 10, 9:30 AM" in the clinic's time zone; falls back to UTC when the zone name is unknown. */
export function formatSlot(startsAt: string, timeZone: string | undefined): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(new Date(startsAt));
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(
      new Date(startsAt),
    );
  }
}
