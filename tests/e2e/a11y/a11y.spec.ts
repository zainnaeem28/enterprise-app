// TC-A11Y-01 (NFR-10): automated WCAG 2.2 AA scan of every key page of the staff portal (staff and administrator
// realms), the patient portal and the brand site, at 1280 px and 360 px (the automated part of TC-A11Y-04).
// Fails on serious/critical axe violations not listed in KNOWN_EXCEPTIONS. Moderate/minor findings are attached to the
// report. The manual runs (TC-A11Y-02/03/07/08, human parts of 04/05/06) remain Pending-human.
import { expect, test } from '@playwright/test';
import { IDS } from '../../../apps/site/e2e/ids.mjs';
import type { Page } from '@playwright/test';
import { PATIENT, SITE, STAFF, UUID, expectClean, mockApi, mockBooking, scan } from './support';
import type { Who } from './support';

interface Pg {
  portal: string;
  who: Who;
  base: string;
  path: string;
  /** Text or heading that must be visible before the scan (a blank or half-loaded page is not scanned). */
  ready?: RegExp;
}

const staff = (who: Who, paths: string[]): Pg[] =>
  paths.map((path) => ({ portal: `staff/${who}`, who, base: STAFF, path }));
const patient = (paths: string[]): Pg[] =>
  paths.map((path) => ({ portal: 'patient', who: 'patient' as Who, base: PATIENT, path }));
const site = (paths: string[]): Pg[] =>
  paths.map((path) => ({ portal: 'site', who: 'none' as Who, base: SITE, path }));

const PAGES: Pg[] = [
  ...staff('none', ['/sign-in', '/signed-out', '/help', '/admin/sign-in']),
  ...staff('staff-desk', ['/arrivals', '/triage', '/forms', '/follow-ups', '/waitlist']),
  ...staff('staff-doctor', [
    '/schedule',
    '/patients',
    '/alerts',
    '/notes-to-sign',
    '/tasks',
    '/availability',
  ]),
  ...staff('admin', [
    '/admin/audit',
    '/admin/btg',
    '/admin/privacy',
    '/admin/users',
    '/admin/clinics',
    '/admin/services',
    '/admin/policies',
    '/admin/templates',
    '/admin/integrations',
    '/admin/flags',
    '/admin/vital-ranges',
  ]),
  ...patient([
    '/',
    '/continue?intent=sign-in',
    '/problem?code=identity.sign_in_failed',
    '/appointments',
    '/book',
    '/book/doctor',
    '/book/time',
    '/book/confirm',
    '/waitlist/join',
    `/appointments/${UUID}/previsit`,
    `/appointments/${UUID}/previsit/questionnaire`,
    `/appointments/${UUID}/previsit/consents`,
    `/appointments/${UUID}/previsit/insurance`,
    `/appointments/${UUID}/previsit/emergency`,
    `/appointments/${UUID}/video`,
    '/profile',
    '/profile/notifications',
    '/family',
    '/family/add',
    '/privacy',
    '/messages',
    '/messages/new',
  ]),
  ...site([
    '/',
    '/about',
    '/services',
    '/doctors',
    `/doctors/${IDS.doctor}`,
    '/locations',
    '/contact',
    '/legal/privacy',
    '/legal/cookies',
    '/nope',
  ]),
];

const BOOKING_STEPS = ['/book/doctor', '/book/time', '/book/confirm'];

async function driveBooking(page: Page, step: number) {
  await page.getByRole('radio', { name: /General visit/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  if (step >= 1) {
    await expect(page).toHaveURL(/\/book\/doctor$/);
    await page.getByLabel('Place').selectOption({ label: 'Main clinic' });
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  if (step >= 2) {
    await expect(page).toHaveURL(/\/book\/time$/);
    await page
      .getByRole('button', { name: /^\d{1,2}:\d{2}\s?[AP]M/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.waitForLoadState('networkidle');
}

const VIEWPORTS = [
  { name: '1280', size: { width: 1280, height: 800 } },
  { name: '360', size: { width: 360, height: 740 } },
];

for (const vp of VIEWPORTS) {
  test.describe(`axe @ ${vp.name} px`, () => {
    test.use({ viewport: vp.size });
    for (const p of PAGES) {
      test(`TC-A11Y-01 ${p.portal} ${p.path}`, async ({ page }, info) => {
        if (p.who !== 'none' || p.base !== SITE) await mockApi(page, p.who);
        const step = BOOKING_STEPS.indexOf(p.path);
        if (step >= 0) await mockBooking(page);
        await page.goto(p.base + (step >= 0 ? '/book' : p.path));
        await page.waitForLoadState('networkidle');
        // The booking steps keep their state in memory, so they are reached by using the flow, not by URL.
        if (step >= 0) await driveBooking(page, step);
        // The page must have rendered real content (a landmark and a heading), not a blank shell.
        // Guard against a silent redirect: the page scanned must be the page named.
        expect(new URL(page.url()).pathname, `${p.path}: scanned a different page`).toBe(
          p.path.split('?')[0],
        );
        await expect(page.locator('main, [role="main"]').first()).toBeVisible();
        await expect(page.getByRole('heading').first()).toBeVisible();
        const o = await scan(page, `${p.portal} ${p.path} @${vp.name}`);
        await info.attach('axe-summary', {
          body: JSON.stringify({ ...o, finalUrl: page.url() }, null, 2),
          contentType: 'application/json',
        });
        if (vp.name === '360') {
          // TC-A11Y-04 automated part: no horizontal scroll at 360 px (WCAG 1.4.10).
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${o.label}: horizontal scroll at 360 px`).toBeLessThanOrEqual(0);
        }
        expectClean(o);
      });
    }
  });
}
