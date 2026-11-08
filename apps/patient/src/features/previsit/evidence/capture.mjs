/* global document, window */
// FE-07 rendered evidence. Run from apps/patient after `vite build`:
//   PW_CHROMIUM=/tmp/pw-browsers/chromium-1248/chrome-linux64/chrome node src/features/previsit/evidence/capture.mjs
// The built app runs in a real Chromium. The API is a CONTRACT MOCK (page.route): no real API, DB, object store or video vendor.
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('./screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = 4175;
const RES = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const CONSENT = '44444444-4444-4444-8444-444444444444';
const RESP = '55555555-5555-4555-8555-555555555555';
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;

const server = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const consent = (over = {}) => ({
  id: CONSENT,
  templateKey: 'telehealth',
  templateVersion: 2,
  language: 'en',
  title: 'Telehealth consent',
  text: 'SYNTHETIC consent wording. I agree to receive care by video and understand the limits of a video visit.',
  status: 'pending',
  ...over,
});
const previsit = (over = {}) => ({
  reservationId: RES,
  questionnaire: false,
  consents: false,
  insurance: false,
  canOpenConsents: true,
  requiredConsents: [consent()],
  ...over,
});
const template = {
  key: 'general',
  version: 2,
  schema: {
    title: 'Health questionnaire',
    questions: [
      { id: 'chest_pain', label: 'Do you have chest pain now?', type: 'yesno' },
      { id: 'reason', label: 'Why are you coming in?', type: 'text' },
      {
        id: 'smoker',
        label: 'Do you smoke?',
        type: 'choice',
        options: ['never', 'former', 'current'],
      },
    ],
  },
};
const forVisit = (response = null) => ({ reservationId: RES, template, response });
const video = (over = {}) => ({
  status: 'open',
  admission: 'waiting',
  joinOpensAt: iso(-5 * MIN),
  needsLocationConfirmation: true,
  startsAt: iso(10 * MIN),
  endsAt: iso(40 * MIN),
  clinicTimeZone: 'America/New_York',
  clinicLocalStart: '2031-06-02T09:30:00',
  ...over,
});
const coverage = {
  id: '77777777-7777-4777-8777-777777777777',
  version: 1,
  payerName: 'SYNTHETIC Health Plan',
  memberId: 'SYN-0001',
  status: 'active',
};

const ONLY = process.env.ONLY;
const scenarios = [
  { id: 'hub-todo', path: `/appointments/${RES}/previsit`, routes: {} },
  {
    id: 'hub-done',
    path: `/appointments/${RES}/previsit`,
    routes: {
      previsit: previsit({
        questionnaire: true,
        consents: true,
        insurance: true,
        requiredConsents: [consent({ status: 'signed' })],
      }),
    },
  },
  {
    id: 'hub-needs-fixing',
    path: `/appointments/${RES}/previsit`,
    routes: {
      previsit: previsit({ requiredConsents: [consent({ status: 'outdated', id: null })] }),
    },
  },
  { id: 'questionnaire', path: `/appointments/${RES}/previsit/questionnaire`, routes: {} },
  {
    id: 'questionnaire-readonly',
    path: `/appointments/${RES}/previsit/questionnaire`,
    routes: {
      questionnaire: forVisit({
        id: RESP,
        answers: { chest_pain: false, reason: 'check-up', smoker: 'never' },
        status: 'submitted',
        redFlag: false,
        version: 2,
      }),
    },
  },
  {
    id: 'questionnaire-conflict',
    path: `/appointments/${RES}/previsit/questionnaire`,
    routes: { putStatus: 412 },
    act: async (p) => {
      await p.getByLabel('No').first().check();
      await p.getByLabel('Why are you coming in?').fill('check-up');
      await p.getByRole('button', { name: /save/i }).first().click();
      await p.waitForTimeout(500);
    },
  },
  { id: 'emergency-red-flag', path: `/appointments/${RES}/previsit/emergency`, routes: {} },
  { id: 'consents-pending', path: `/appointments/${RES}/previsit/consents`, routes: {} },
  {
    id: 'consents-signed',
    path: `/appointments/${RES}/previsit/consents`,
    routes: {
      previsit: previsit({ consents: true, requiredConsents: [consent({ status: 'signed' })] }),
    },
  },
  {
    id: 'consents-validation',
    path: `/appointments/${RES}/previsit/consents`,
    routes: {},
    act: async (p) => {
      await p.getByRole('button', { name: 'Sign' }).click();
      await p.waitForTimeout(300);
    },
  },
  { id: 'insurance-empty', path: `/appointments/${RES}/previsit/insurance`, routes: {} },
  {
    id: 'insurance-card',
    path: `/appointments/${RES}/previsit/insurance`,
    routes: { coverages: { items: [coverage] } },
  },
  {
    id: 'video-device-check',
    path: `/appointments/${RES}/video`,
    routes: { video: video({ needsLocationConfirmation: false }) },
  },
  {
    id: 'video-both-zones',
    path: `/appointments/${RES}/video`,
    tz: 'America/Los_Angeles',
    routes: { video: video() },
  },
  {
    id: 'video-early',
    path: `/appointments/${RES}/video`,
    routes: { video: video({ joinOpensAt: iso(5 * MIN), startsAt: iso(15 * MIN) }) },
  },
  {
    id: 'video-waiting',
    path: `/appointments/${RES}/video`,
    routes: { video: video({ needsLocationConfirmation: false }), notAdmitted: true },
    act: async (p) => {
      await p
        .getByRole('button', { name: /join/i })
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(800);
    },
  },
  {
    id: 'video-removed',
    path: `/appointments/${RES}/video`,
    routes: { video: video({ admission: 'removed', needsLocationConfirmation: false }) },
  },
  {
    id: 'video-ended',
    path: `/appointments/${RES}/video`,
    routes: { video: video({ status: 'ended' }) },
  },
];

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'reflow320', width: 320, height: 640 },
];

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  ...(process.env.PW_DUMPIO
    ? {
        logger: {
          isEnabled: () => true,
          log: (n, s, m) => console.log('[pw]', String(m).slice(0, 200)),
        },
      }
    : {}),
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const results = [];
try {
  for (const sc of scenarios.filter((s) => !ONLY || s.id === ONLY)) {
    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        timezoneId: sc.tz ?? 'America/New_York',
      });
      const page = await ctx.newPage();
      page.on('crash', () => console.log('PAGE CRASH', sc.id, vp.name));
      page.on('close', () => console.log('PAGE CLOSE', sc.id, vp.name));
      page.on(
        'console',
        (m) => m.type() === 'error' && console.log('console.error', sc.id, m.text().slice(0, 160)),
      );
      page.on('pageerror', (e) => console.log('pageerror', sc.id, String(e).slice(0, 120)));
      const json = (route, status, body, headers = {}) =>
        route.fulfill({
          status,
          contentType: status >= 400 ? 'application/problem+json' : 'application/json',
          headers,
          body: JSON.stringify(body),
        });
      await page.route('**/api/v1/**', async (route) => {
        const u = new URL(route.request().url());
        const m = route.request().method();
        const r = sc.routes;
        const p = u.pathname;
        if (p === '/api/v1/auth/session')
          return json(
            route,
            200,
            {
              principalId: '11111111-1111-4111-8111-111111111111',
              realm: 'patient',
              audience: 'patient',
              displayName: 'Test Patient',
              csrfToken: 'csrf',
              idleExpiresAt: iso(30 * MIN),
              roles: [],
              permissions: [],
              patients: [{ patientId: ME, relation: 'self', scope: 'full' }],
            },
            { 'x-session-idle-expires-at': iso(30 * MIN) },
          );
        if (p === '/api/v1/me') return json(route, 200, { patients: [{ patientId: ME }] });
        if (p === `/api/v1/appointments/${RES}/previsit`)
          return json(route, 200, r.previsit ?? previsit());
        if (p === `/api/v1/appointments/${RES}/questionnaire`)
          return json(route, 200, r.questionnaire ?? forVisit(), { etag: 'W/"1"' });
        if (p.startsWith('/api/v1/questionnaire-responses/') && m === 'PUT')
          return r.putStatus
            ? json(route, r.putStatus, {
                status: r.putStatus,
                code: 'kernel.precondition_failed',
                requestId: 'r',
              })
            : json(
                route,
                200,
                { id: RESP, answers: {}, status: 'in_progress', redFlag: false, version: 1 },
                { etag: 'W/"1"' },
              );
        if (p === `/api/v1/patients/${ME}/insurance-coverages`)
          return json(route, 200, r.coverages ?? { items: [] });
        if (p === `/api/v1/patients/${ME}/documents`) return json(route, 200, { items: [] });
        if (p === `/api/v1/appointments/${RES}/video-session`)
          return json(route, 200, r.video ?? video());
        if (p === `/api/v1/appointments/${RES}/video-session/location`)
          return json(route, 200, { result: 'allowed', flagged: false });
        if (p === `/api/v1/appointments/${RES}/video-session/join`)
          return r.notAdmitted
            ? json(route, 409, { status: 409, code: 'telehealth.not_admitted', requestId: 'r' })
            : json(route, 200, { vendor: 'mock', meetingId: 'm', attendeeToken: 't' });
        return json(route, 404, { status: 404, code: 'kernel.not_found', requestId: 'r' });
      });
      await page.goto(`http://127.0.0.1:${PORT}${sc.path}`);
      await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(600);
      if (sc.act) await sc.act(page);
      await page.screenshot({ path: `${OUT}${sc.id}.${vp.name}.png`, fullPage: true });
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const small = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [tabindex="0"]',
          ),
        ]
          .map((e) => {
            // A radio or checkbox is operated through its label, so the label's box is the target.
            const lab = e.labels && e.labels.length ? e.labels[0] : null;
            const r = (
              lab && (e.type === 'radio' || e.type === 'checkbox') ? lab : e
            ).getBoundingClientRect();
            return {
              tag: e.tagName.toLowerCase(),
              text: (e.getAttribute('aria-label') || e.textContent || e.id || '')
                .trim()
                .slice(0, 40),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          })
          .filter((x) => x.w > 0 && (x.w < 44 || x.h < 44) && x.text !== 'Skip to main content'),
      );
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        wide: [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 5)
          .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).slice(0, 30)}`),
      }));
      results.push({
        scenario: sc.id,
        viewport: vp.name,
        h1: await page
          .locator('h1')
          .first()
          .textContent()
          .catch(() => null),
        axeViolations: axe.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target.join(' ')),
        })),
        targetsUnder44: small,
        horizontalOverflow: overflow.scrollWidth > overflow.innerWidth,
        ...overflow,
      });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(
  new URL('./browser-report.json', import.meta.url),
  JSON.stringify(
    {
      chromium: 'chromium-1248 (Playwright 1.64.1)',
      apiMock: 'contract mock via page.route; no real API/DB/vendor',
      results,
    },
    null,
    2,
  ),
);
const bad = results.filter(
  (r) => r.axeViolations.length || r.targetsUnder44.length || r.horizontalOverflow,
);
console.log(`${results.length} captures; ${bad.length} with findings`);
for (const r of bad)
  console.log(
    r.scenario,
    r.viewport,
    'axe:',
    r.axeViolations.map((v) => v.id).join(',') || '-',
    'small:',
    r.targetsUnder44.map((t) => `${t.tag}:${t.text}:${t.w}x${t.h}`).join('|'),
    'overflow:',
    r.horizontalOverflow,
    r.wide?.join(','),
  );
