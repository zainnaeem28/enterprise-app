import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOfDayIn, toBusyChange } from './busy.js';
import { discardedMarker, eventIdFor, externalHash, sha256, tokenSecretName } from './ids.js';

const at = (s: string): { dateTime: string } => ({ dateTime: s });

test('busy: opaque and tentative events block time; cancelled, free, declined and our own do not (BR-07: only an ID and an interval survive)', () => {
  const ev = {
    id: 'a',
    status: 'confirmed',
    summary: 'Dr Smith - HIV CANARY',
    start: at('2031-05-01T14:00:00Z'),
    end: at('2031-05-01T15:00:00Z'),
  };
  const c = toBusyChange(ev as never);
  assert.deepEqual(c, {
    eventId: 'a',
    busy: { startsAt: '2031-05-01T14:00:00.000Z', endsAt: '2031-05-01T15:00:00.000Z' },
  });
  assert.ok(!JSON.stringify(c).includes('CANARY'));
  assert.ok(toBusyChange({ ...ev, status: 'tentative' } as never)?.busy);
  assert.equal(toBusyChange({ ...ev, status: 'cancelled' } as never)?.busy, null);
  assert.equal(toBusyChange({ ...ev, transparency: 'transparent' } as never)?.busy, null);
  assert.equal(
    toBusyChange({ ...ev, attendees: [{ self: true, responseStatus: 'declined' }] } as never)?.busy,
    null,
  );
  assert.ok(
    toBusyChange({ ...ev, attendees: [{ self: false, responseStatus: 'declined' }] } as never)
      ?.busy,
    'another attendee declining does not free the doctor',
  );
  assert.equal(
    toBusyChange({ ...ev, extendedProperties: { private: { ehrBusy: '1' } } } as never)?.busy,
    null,
  );
  assert.ok(
    toBusyChange({ ...ev, extendedProperties: { private: { other: 'x' } } } as never)?.busy,
  );
});

test('busy: malformed events are not busy time and never throw', () => {
  assert.equal(toBusyChange({} as never), undefined);
  assert.equal(toBusyChange({ id: '' } as never), undefined);
  assert.equal(toBusyChange({ id: 'x'.repeat(2000) } as never), undefined);
  for (const bad of [
    { id: 'a' },
    { id: 'a', start: at('nope'), end: at('2031-05-01T15:00:00Z') },
    { id: 'a', start: at('2031-05-01T15:00:00Z'), end: at('2031-05-01T15:00:00Z') },
    { id: 'a', start: at('2031-05-01T16:00:00Z'), end: at('2031-05-01T15:00:00Z') },
    { id: 'a', start: { date: '2031-13-45' }, end: { date: '2031-13-46' } },
  ])
    assert.equal(toBusyChange(bad as never)?.busy ?? null, null);
  const long = toBusyChange({
    id: 'a',
    start: at('2031-01-01T00:00:00Z'),
    end: at('2040-01-01T00:00:00Z'),
  } as never);
  assert.ok(
    Date.parse(long?.busy?.endsAt as string) - Date.parse(long?.busy?.startsAt as string) <=
      399 * 86_400_000,
    'clipped under the database limit',
  );
});

test("all-day events block the local days in the event zone, else the calendar zone; daylight saving is the platform's", () => {
  const ny = toBusyChange(
    { id: 'x', start: { date: '2031-07-04' }, end: { date: '2031-07-06' } } as never,
    'America/New_York',
  );
  assert.deepEqual(ny?.busy, {
    startsAt: '2031-07-04T04:00:00.000Z',
    endsAt: '2031-07-06T04:00:00.000Z',
  });
  const own = toBusyChange(
    {
      id: 'x',
      start: { date: '2031-07-04', timeZone: 'America/Los_Angeles' },
      end: { date: '2031-07-05', timeZone: 'America/Los_Angeles' },
    } as never,
    'America/New_York',
  );
  assert.equal(own?.busy?.startsAt, '2031-07-04T07:00:00.000Z');
  assert.equal(
    startOfDayIn('2031-03-09', 'America/New_York'),
    Date.parse('2031-03-09T05:00:00.000Z'),
  );
  assert.equal(
    startOfDayIn('2031-03-10', 'America/New_York'),
    Date.parse('2031-03-10T04:00:00.000Z'),
  );
  assert.equal(
    startOfDayIn('2031-11-02', 'America/New_York'),
    Date.parse('2031-11-02T04:00:00.000Z'),
  );
  assert.equal(
    startOfDayIn('2031-11-03', 'America/New_York'),
    Date.parse('2031-11-03T05:00:00.000Z'),
  );
  assert.equal(
    startOfDayIn('2031-07-04', 'Not/AZone'),
    Date.parse('2031-07-04T00:00:00.000Z'),
    'an unknown zone is UTC',
  );
  assert.equal(startOfDayIn('2031-07-04', undefined), Date.parse('2031-07-04T00:00:00.000Z'));
  assert.equal(startOfDayIn('July 4', 'UTC'), undefined);
});

test("identifiers: deterministic, in Google's alphabet, and one secret name per doctor", () => {
  const occ = '0192abcd-1234-7abc-8def-0123456789ab';
  assert.equal(eventIdFor(occ), 'ehr0192abcd12347abc8def0123456789ab');
  assert.match(eventIdFor(occ), /^[a-v0-9]{5,255}$/);
  assert.equal(eventIdFor(occ.toUpperCase()), eventIdFor(occ));
  assert.equal(externalHash('e1').length, 32);
  assert.deepEqual(externalHash('e1'), externalHash('e1'));
  assert.notDeepEqual(externalHash('e1'), externalHash('e2'));
  assert.equal(tokenSecretName(occ.toUpperCase()), `cal-${occ}`);
  assert.match(discardedMarker(sha256('t')), /^[0-9a-f-]{36}$/);
});
