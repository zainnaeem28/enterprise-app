import { describe, expect, it } from 'vitest';
import { localDate, strandedVisits } from './affected.js';
import type { Template } from './types.js';

const rules = (...r: [number, string, string][]): Template['rules'] =>
  r.map(([weekday, startLocal, endLocal]) => ({
    weekday,
    startLocal,
    endLocal,
    serviceIds: null,
    mode: 'either' as const,
    roomId: null,
    overbookable: false,
  }));
const hours = (r: Template['rules'], validFrom = '2020-01-01', validTo: string | null = null) => ({
  validFrom,
  validTo,
  rules: r,
});
// 2031-06-10 is a Tuesday (weekday 2).
const visit = (startsAt: string, endsAt: string, status = 'confirmed') => ({
  startsAt,
  endsAt,
  status,
});

describe('strandedVisits', () => {
  const tue = visit('2031-06-10T10:00:00Z', '2031-06-10T10:30:00Z');

  it('counts a visit the old hours covered and the new hours do not', () => {
    const before = [hours(rules([2, '09:00', '17:00']))];
    expect(strandedVisits(before, [hours(rules([3, '09:00', '17:00']))], [tue], 'UTC')).toEqual([
      tue,
    ]);
    expect(strandedVisits(before, [hours(rules([2, '10:30', '17:00']))], [tue], 'UTC')).toEqual([
      tue,
    ]);
  });

  it('leaves a visit alone when the new hours still cover it', () => {
    const before = [hours(rules([2, '09:00', '17:00']))];
    expect(strandedVisits(before, [hours(rules([2, '08:00', '12:00']))], [tue], 'UTC')).toEqual([]);
  });

  it('does not blame the change for a visit outside the old hours too', () => {
    expect(strandedVisits([], [hours(rules([3, '09:00', '17:00']))], [tue], 'UTC')).toEqual([]);
  });

  it('adding hours never strands anything', () => {
    const before = [hours(rules([2, '09:00', '17:00']))];
    const after = [...before, hours(rules([3, '09:00', '17:00']))];
    expect(strandedVisits(before, after, [tue], 'UTC')).toEqual([]);
  });

  it('ignores finished and cancelled visits', () => {
    const before = [hours(rules([2, '09:00', '17:00']))];
    const gone = [
      visit(tue.startsAt, tue.endsAt, 'completed'),
      visit(tue.startsAt, tue.endsAt, 'cancelled'),
      visit(tue.startsAt, tue.endsAt, 'no_show'),
    ];
    expect(strandedVisits(before, [], gone, 'UTC')).toEqual([]);
  });

  it('respects the valid-from and valid-to dates of the new hours', () => {
    const before = [hours(rules([2, '09:00', '17:00']))];
    const after = [hours(rules([2, '09:00', '17:00']), '2031-06-17')];
    expect(strandedVisits(before, after, [tue], 'UTC')).toEqual([tue]);
    expect(
      strandedVisits(
        before,
        [hours(rules([2, '09:00', '17:00']), '2020-01-01', '2031-06-10')],
        [tue],
        'UTC',
      ),
    ).toEqual([]);
  });

  it('reads the visit in the time zone of the location, not the device', () => {
    // 21:30 UTC on Tuesday is 02:30 on Wednesday in Karachi (UTC+5).
    const late = visit('2031-06-10T21:30:00Z', '2031-06-10T22:00:00Z');
    const wed = hours(rules([3, '02:00', '04:00']));
    expect(strandedVisits([wed], [], [late], 'Asia/Karachi')).toEqual([late]);
    expect(strandedVisits([wed], [], [late], 'UTC')).toEqual([]);
  });
});

describe('localDate', () => {
  it('adds days on the calendar of the location', () => {
    const now = new Date('2031-06-10T22:00:00Z'); // already Wednesday in Karachi
    expect(localDate(now, 'Asia/Karachi')).toBe('2031-06-11');
    expect(localDate(now, 'UTC', 1)).toBe('2031-06-11');
    expect(localDate(new Date('2031-12-31T12:00:00Z'), 'UTC', 1)).toBe('2032-01-01');
  });
});
