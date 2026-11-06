import { describe, expect, it } from 'vitest';
import { buildIcs } from './ics.js';
import { matchBookingRoute } from './routes.js';
import { mmss, secondsLeft, whenLabel, whenLabels } from './time.js';
import { failureOf } from './api.js';
import { parseAppointment } from './types.js';

const OCTETS = (s: string) => new TextEncoder().encode(s).length;

describe('add to calendar (.ics)', () => {
  const ics = buildIcs(
    { id: 'abc-123', startsAt: '2031-06-10T14:00:00.000Z', endsAt: '2031-06-10T15:00:00.000Z' },
    new Date('2031-06-01T08:00:00Z'),
  );
  const lines = ics.split('\r\n');

  it('is a well-formed VCALENDAR with one VEVENT and CRLF line ends', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(lines.slice(0, 3)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Patient portal//Appointment//EN',
    ]);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    expect(lines[lines.length - 2]).toBe('END:VCALENDAR');
  });

  it('carries the required event properties with UTC times', () => {
    expect(lines).toContain('UID:abc-123@patient-portal');
    expect(lines).toContain('DTSTAMP:20310601T080000Z');
    expect(lines).toContain('DTSTART:20310610T140000Z');
    expect(lines).toContain('DTEND:20310610T150000Z');
  });

  it('names the event only "Appointment" (BR-23) and folds lines to 75 octets', () => {
    expect(lines).toContain('SUMMARY:Appointment');
    expect(ics).not.toMatch(/Dr\.|clinic/i);
    const long = buildIcs({
      id: 'x'.repeat(200),
      startsAt: '2031-06-10T14:00:00Z',
      endsAt: '2031-06-10T15:00:00Z',
    });
    for (const l of long.split('\r\n')) expect(OCTETS(l)).toBeLessThanOrEqual(75);
    // Unfolding gives back the original UID.
    expect(long.replace(/\r\n /g, '')).toContain(`UID:${'x'.repeat(200)}@patient-portal`);
  });
});

describe('times (UX-R8, BR-05)', () => {
  const iso = '2031-06-10T14:00:00.000Z';
  it('shows the clinic zone label', () => {
    expect(whenLabel(iso, 'America/New_York')).toBe('Tue, Jun 10, 10:00 AM EDT');
  });
  it('shows both zones for a video visit when they differ, one otherwise', () => {
    expect(whenLabels(iso, 'America/New_York', true, 'America/Los_Angeles')).toEqual([
      'Tue, Jun 10, 10:00 AM EDT',
      'Tue, Jun 10, 7:00 AM PDT',
    ]);
    expect(whenLabels(iso, 'America/New_York', true, 'America/New_York')).toHaveLength(1);
    expect(whenLabels(iso, 'America/New_York', false, 'America/Los_Angeles')).toHaveLength(1);
  });
  it('counts down to the server expiry corrected by the server clock offset', () => {
    const expires = '2031-06-10T14:10:00.000Z';
    const now = Date.parse('2031-06-10T14:00:00.000Z');
    expect(secondsLeft(expires, 0, now)).toBe(600);
    // The device clock is 3 minutes slow: the server is 180 s ahead, so 420 s are left.
    expect(secondsLeft(expires, 180_000, now)).toBe(420);
    expect(secondsLeft(expires, 0, now + 11 * 60_000)).toBe(0);
    expect(mmss(582)).toBe('09:42');
  });
});

describe('routes and answers', () => {
  it('routes carry ids only', () => {
    expect(matchBookingRoute('/book')).toEqual({ name: 'service' });
    expect(matchBookingRoute('/appointments/66666666-6666-4666-8666-666666666666/cancel')).toEqual({
      name: 'cancel',
      id: '66666666-6666-4666-8666-666666666666',
    });
    expect(matchBookingRoute('/appointments/jane-doe')).toBeUndefined();
    expect(matchBookingRoute('/account')).toBeUndefined();
  });
  it('reads slot_taken alternatives from the error entries', () => {
    const f = failureOf(new Response(null, { status: 409 }), {
      code: 'scheduling.slot_taken',
      requestId: 'r1',
      errors: [
        { path: '/alternatives/0', code: '2031-06-10T15:00:00.000Z' },
        { path: '/alternatives/1', code: 'not a time' },
        { path: '/other', code: '2031-06-10T16:00:00.000Z' },
      ],
    });
    expect(f).toMatchObject({ status: 409, code: 'scheduling.slot_taken', requestId: 'r1' });
    expect(f.alternatives).toEqual(['2031-06-10T15:00:00.000Z']);
  });
  it('reads alternatives from the documented top-level array too, without duplicates', () => {
    const f = failureOf(new Response(null, { status: 409 }), {
      code: 'scheduling.hold_expired',
      alternatives: ['2031-06-10T15:00:00.000Z', 'nope', 7],
      errors: [{ path: '/alternatives/0', code: '2031-06-10T15:00:00.000Z' }],
    });
    expect(f.alternatives).toEqual(['2031-06-10T15:00:00.000Z']);
  });
  it('rejects a malformed appointment instead of rendering it', () => {
    expect(parseAppointment({ id: 'a' })).toBeUndefined();
    expect(parseAppointment(null)).toBeUndefined();
  });
});
