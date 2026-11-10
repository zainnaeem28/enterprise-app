// The appointment's calendar file (`GET /appointments/{id}/calendar.ics`, ARCHITECTURE 29.2, RA-R1-02). RFC 5545: CRLF line ends,
// UTC times, UID, DTSTAMP, lines folded at 75 octets. BR-23: the summary is the fixed word "Appointment"; no service, clinician,
// place or reason goes into the file, so the file is safe to import into any personal calendar.
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
    const n = Buffer.byteLength(ch, 'utf8');
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

export function buildAppointmentIcs(
  a: { id: string; startsAt: string; endsAt: string },
  now: Date = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EHR//Appointment//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.id}@ehr-appointment`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(new Date(a.startsAt))}`,
    `DTEND:${stamp(new Date(a.endsAt))}`,
    'SUMMARY:Appointment',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.flatMap(fold).join('\r\n') + '\r\n';
}
