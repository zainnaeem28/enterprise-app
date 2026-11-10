// Shared helpers for the QA-06 accessibility and browser-matrix specs. API answers are CONTRACT MOCKS of the documented
// shapes (session) and empty collections (everything else); they prove the rendered UI, not the API.
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const STAFF = 'http://127.0.0.1:4173';
export const PATIENT = 'http://127.0.0.1:4174';
export const SITE = 'http://127.0.0.1:4320';

const UUID = '5b0d3a6e-1111-4222-8333-444455556666';
export { UUID };

export type Who = 'staff-doctor' | 'staff-desk' | 'admin' | 'patient' | 'none';

const ALL_PERMISSIONS: string[] = [];

function session(who: Exclude<Who, 'none'>) {
  const base = {
    csrfToken: 'csrf-qa',
    idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    permissions: ALL_PERMISSIONS,
    patients: [] as unknown[],
  };
  if (who === 'patient')
    return {
      ...base,
      principalId: UUID,
      realm: 'patient_pool',
      audience: 'patient',
      displayName: 'Test Patient',
      roles: [],
      roleKeys: [],
      patients: [{ patientId: UUID, relation: 'self', scope: 'full' }],
    };
  if (who === 'admin')
    return {
      ...base,
      principalId: UUID,
      realm: 'admin_pool',
      audience: 'staff',
      displayName: 'Test Admin',
      roles: [{ key: 'administrator' }],
      roleKeys: ['administrator'],
    };
  const key = who === 'staff-doctor' ? 'doctor' : 'front_desk';
  return {
    ...base,
    principalId: UUID,
    realm: 'google',
    audience: 'staff',
    displayName: 'Test Staff',
    roles: [{ key, locationId: UUID }],
    roleKeys: [key],
  };
}

/** Answers the session as `who` (or 401), a release.json with no newer release, and every other GET with an empty list. */
export async function mockApi(page: Page, who: Who) {
  await page.route('**/release.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ release_number: 1 }) }),
  );
  await page.route('**/api/v1/**', (r) => {
    const url = new URL(r.request().url());
    const json = (status: number, body: unknown) =>
      r.fulfill({
        status,
        contentType: status < 300 ? 'application/json' : 'application/problem+json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/v1/auth/session')
      return who === 'none'
        ? json(401, { status: 401, code: 'auth.unauthenticated', requestId: 'req-qa' })
        : json(200, session(who));
    if (url.pathname === '/api/v1/me')
      return json(200, { patients: [{ patientId: UUID, relation: 'self' }] });
    return json(200, { items: [], nextCursor: null });
  });
}

/**
 * Booking-flow answers (one service, one place, one doctor, one open time, a hold) layered over `mockApi`, so the
 * doctor, time and confirm steps render instead of redirecting to /book (their state lives in memory only).
 */
export async function mockBooking(page: Page) {
  const startsAt = new Date(Date.now() + 26 * 3_600_000);
  startsAt.setUTCMinutes(0, 0, 0);
  const slot = {
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 1_800_000).toISOString(),
    clinicianId: UUID,
    locationId: UUID,
    mode: 'in_person',
  };
  await page.route('**/api/v1/**', (r) => {
    const { pathname } = new URL(r.request().url());
    const ok = (body: unknown) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/v1/services')
      return ok({ items: [{ id: UUID, name: 'General visit', durationMin: 30, mode: 'in_person' }] });
    if (pathname === '/api/v1/locations')
      return ok({ items: [{ id: UUID, name: 'Main clinic', timeZone: 'UTC' }] });
    if (pathname === '/api/v1/clinicians')
      return ok({ items: [{ clinicianId: UUID, displayName: 'Dr Test' }] });
    if (pathname === '/api/v1/availability/search') return ok({ slots: [slot] });
    if (pathname === '/api/v1/holds')
      return ok({ reservationId: UUID, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    return r.fallback();
  });
}

export interface AxeOutcome {
  label: string;
  rulesPassed: number;
  serious: string[];
  minor: string[];
}

/** Known exceptions: none yet. Each entry needs rule id, reason and owner (TC-A11Y-01 expected result). */
export const KNOWN_EXCEPTIONS: { rule: string; reason: string; owner: string }[] = [];

export async function scan(page: Page, label: string): Promise<AxeOutcome> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const excepted = new Set(KNOWN_EXCEPTIONS.map((e) => e.rule));
  const line = (v: (typeof results.violations)[number]) =>
    `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
  const bad = results.violations.filter(
    (v) => (v.impact === 'serious' || v.impact === 'critical') && !excepted.has(v.id),
  );
  const out = {
    label,
    rulesPassed: results.passes.length,
    serious: bad.map(line),
    minor: results.violations.filter((v) => !bad.includes(v)).map(line),
  };
  expect(out.rulesPassed, `${label}: axe evaluated no rule (empty scan)`).toBeGreaterThan(0);
  return out;
}

export function expectClean(o: AxeOutcome) {
  expect(o.serious, `${o.label}: serious/critical axe violations`).toEqual([]);
}
