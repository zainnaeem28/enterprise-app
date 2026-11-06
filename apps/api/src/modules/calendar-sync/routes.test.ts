import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventory } from '../../platform/inventory.js';
import { PUBLIC } from '../../platform/permissions.js';
import { calendarResolvers, createCalendarControllers } from './controller.js';

const controllers = createCalendarControllers({
  db: {} as never,
  links: {} as never,
  push: {} as never,
  returnUrl: 'https://staff.example.test/doctor/calendar',
});

test('route inventory (38.2 item 9): every route declares a known permission and a resolver; the five routes of 29.3 and 29.5 exist', () => {
  const r = inventory(controllers as never);
  assert.deepEqual(r.failures, []);
  const got = r.routes.map((x) => `${x.method} ${x.path} ${x.declaration?.permission}`).sort();
  assert.deepEqual(
    got,
    [
      'DELETE /api/v1/calendar-link calendar.link.own',
      'GET /api/v1/calendar-link calendar.link.own',
      'GET /api/v1/calendar-link/callback calendar.link.own',
      `POST /webhooks/google/calendar ${PUBLIC}`,
      'POST /api/v1/calendar-link/start calendar.link.own',
    ].sort(),
  );
});

test('the link routes are google-realm only; the callback and the webhook are the only release-exempt routes (28.6)', () => {
  const r = inventory(controllers as never);
  for (const x of r.routes.filter((e) => e.path.startsWith('/api/v1/calendar-link')))
    assert.equal(x.declaration?.realm, 'google', x.path);
  assert.deepEqual(
    r.routes
      .filter((e) => e.declaration?.releaseExempt === true)
      .map((e) => e.path)
      .sort(),
    ['/api/v1/calendar-link/callback', '/webhooks/google/calendar'],
  );
  assert.deepEqual(Object.keys(calendarResolvers()), ['calendar-own']);
  for (const x of r.routes)
    assert.ok(x.declaration?.resolver === 'calendar-own' || x.declaration?.resolver === 'none');
});
