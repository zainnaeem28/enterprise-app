import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAppointmentIcs } from './ics.js';

describe('appointment calendar file (QA-EXEC-F08, BR-23)', () => {
  const ics = buildAppointmentIcs(
    {
      id: '00000000-0000-7000-8000-000000000999',
      startsAt: '2027-03-12T17:00:00.000Z',
      endsAt: '2027-03-12T17:30:00.000Z',
    },
    new Date('2027-03-01T08:00:00.000Z'),
  );

  test('is one RFC 5545 event in UTC with CRLF line ends', () => {
    const lines = ics.split('\r\n');
    assert.equal(lines.at(-1), '');
    for (const l of [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:00000000-0000-7000-8000-000000000999@ehr-appointment',
      'DTSTAMP:20270301T080000Z',
      'DTSTART:20270312T170000Z',
      'DTEND:20270312T173000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
      assert.ok(lines.includes(l), l);
    assert.ok(!ics.replace(/\r\n/g, '').includes('\n'));
  });

  test('the summary is the fixed word and nothing else identifies the visit', () => {
    assert.ok(ics.includes('SUMMARY:Appointment\r\n'));
    assert.ok(!/LOCATION|DESCRIPTION|ATTENDEE|ORGANIZER/.test(ics));
  });
});
