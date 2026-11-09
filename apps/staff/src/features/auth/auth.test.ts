import { describe, expect, it } from 'vitest';
import { allNavPaths, navigationFor, surfaces } from './navigation.js';
import { googleSignInHref, safeReturnTo } from './return-to.js';

const labels = (roles: string[]) => navigationFor(roles).map((i) => i.label);

describe('role navigation follows UI-UX 3.2', () => {
  it('doctor roles get the Doctor map', () => {
    for (const r of ['doctor', 'trainee_doctor', 'assistant'])
      expect(labels([r])).toEqual([
        'Alerts',
        'Schedule',
        'Patients',
        'Tasks & messages',
        'Notes to sign',
        'Availability',
      ]);
  });
  it('front-desk, triage and coordination roles get the Pre-consultation map', () => {
    for (const r of [
      'front_desk',
      'front_desk_lead',
      'triage_nurse',
      'care_coordinator',
      'medical_records',
    ])
      expect(labels([r])).toEqual([
        'Arrivals',
        'Triage queue',
        'Forms & consents',
        'Follow-ups',
        'Waitlist',
      ]);
  });
  it('a person with both kinds of role gets both maps once', () => {
    expect(navigationFor(['front_desk', 'doctor', 'triage_nurse'])).toHaveLength(11);
  });
  it('admin-realm and unknown roles get nothing', () => {
    expect(navigationFor(['org_admin', 'compliance_officer', 'made_up'])).toEqual([]);
    expect(navigationFor([])).toEqual([]);
  });
  it('offers no R2/R3 item and no path carries an identifier', () => {
    const all = [...surfaces.doctor, ...surfaces.preconsult];
    expect(all.map((i) => i.label.toLowerCase()).join()).not.toMatch(/prescription|result|\blab\b/);
    for (const i of all) expect(i.path).toMatch(/^\/[a-z-]+$/);
  });
});

describe('returnTo carries a known screen path only', () => {
  it('accepts navigation paths', () => {
    for (const p of allNavPaths) expect(safeReturnTo(p)).toBe(p);
  });
  it.each([
    '/patients/123',
    '/patients?name=Jane',
    '/patients#x',
    'https://evil.example/',
    '//evil.example',
    '/\\evil',
    '/',
    '',
    null,
    undefined,
  ])('refuses %s', (v) => {
    expect(safeReturnTo(v)).toBeUndefined();
  });
  it('builds the Google sign-in link on the typed route', () => {
    expect(googleSignInHref('/schedule')).toBe('/api/v1/auth/sign-in?returnTo=%2Fschedule');
    expect(googleSignInHref('/patients/1')).toBe('/api/v1/auth/sign-in');
  });
});
