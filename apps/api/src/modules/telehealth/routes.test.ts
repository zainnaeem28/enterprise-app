import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventory } from '../../platform/inventory.js';
import { PASSIVE_ROUTES } from '../identity/index.js';
import { createTelehealthControllers } from './controller.js';

const controllers = createTelehealthControllers({ db: {} as never, telehealth: {} as never });

test('route inventory (38.2 item 9): every route declares a known permission and the booking core resolver', () => {
  const r = inventory(controllers as never);
  assert.deepEqual(r.failures, []);
  const got = r.routes.map((x) => `${x.method} ${x.path} ${x.declaration?.permission}`).sort();
  assert.deepEqual(
    got,
    [
      'GET /api/v1/appointments/:id/video-session proxy',
      'POST /api/v1/appointments/:id/video-session/device-check patient',
      'POST /api/v1/appointments/:id/video-session/location patient',
      'POST /api/v1/appointments/:id/video-session/join proxy',
      'GET /api/v1/appointments/:id/video-session/host telehealth.session.host',
      'POST /api/v1/appointments/:id/video-session/host/join telehealth.session.host',
      'POST /api/v1/appointments/:id/video-session/admit telehealth.session.host',
      'POST /api/v1/appointments/:id/video-session/end telehealth.session.host',
    ].sort(),
  );
  for (const x of r.routes) assert.equal(x.declaration?.resolver, 'reservation', x.path);
});

test('the host routes are google-realm only; the patient routes declare no realm of their own (the capability decides it)', () => {
  const r = inventory(controllers as never);
  for (const x of r.routes.filter((e) => e.declaration?.permission === 'telehealth.session.host'))
    assert.equal(x.declaration?.realm, 'google', x.path);
  for (const x of r.routes.filter((e) => e.declaration?.permission !== 'telehealth.session.host'))
    assert.equal(x.declaration?.realm, undefined, x.path);
});

test('the status poll of the patient is passive (26.2); the host poll is not on the closed list until it is added (README D1)', () => {
  const passive = (method: string, path: string): boolean =>
    PASSIVE_ROUTES.some((p) => p.method === method && p.pattern.test(path));
  assert.equal(
    passive('GET', '/api/v1/appointments/0192abcd-1234-7abc-8def-0123456789ab/video-session'),
    true,
  );
  assert.equal(passive('POST', '/api/v1/appointments/x/video-session/join'), false);
  // Documents the open decision: with the requested patch (identity/sessions.ts) this becomes true.
  assert.equal(
    passive('GET', '/api/v1/appointments/0192abcd-1234-7abc-8def-0123456789ab/video-session/host'),
    false,
  );
});
