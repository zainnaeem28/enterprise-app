// Add to calendar (PP-14, PP-15). Built in the browser from the confirmed appointment so it works whether or not the
// calendar.ics route is mounted. RFC 5545: CRLF line ends, UTC times, UID, DTSTAMP, lines folded at 75 octets.
// BR-23: the summary is the fixed word "Appointment"; no service, doctor or place name goes into the file.

const stamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

function fold(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > (out.length === 0 ? 75 : 74)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`));
}

export function buildIcs(
  a: { id: string; startsAt: string; endsAt: string },
  now = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Patient portal//Appointment//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.id}@patient-portal`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(new Date(a.startsAt))}`,
    `DTEND:${stamp(new Date(a.endsAt))}`,
    'SUMMARY:Appointment',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.flatMap(fold).join('\r\n') + '\r\n';
}

/** Offers the file to the browser; the object URL is released straight after the click. */
export function downloadIcs(a: { id: string; startsAt: string; endsAt: string }): void {
  const url = URL.createObjectURL(new Blob([buildIcs(a)], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'appointment.ics';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
