// F-07 journey: the BUILT staff shell in Chromium -> same-origin /api (vite preview proxy) -> API container ->
// PostgreSQL 17 through the scope setter under row-level security -> the rendered answer. Fails on any console script
// error, any request to another origin, any failed request.
import { expect, test } from '@playwright/test';

test('browser shell -> same-origin API -> PostgreSQL (scope setter, RLS) -> rendered result', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
  const api: Array<{ path: string; status: number; release: string | undefined }> = [];
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith('data:') && new URL(r.url()).origin !== origin) foreign.push(r.url());
  });
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/'))
      api.push({
        path: u.pathname,
        status: res.status(),
        release: res.request().headers()['x-client-release'],
      });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff portal' })).toBeVisible();
  await expect(page.getByText('Checking the server…')).toBeHidden();
  // The shell has no identity yet (INT-01): the real API answers "not signed in", and the shell renders that answer.
  await expect(page.getByText('You are not signed in')).toBeVisible();
  const text = (await page.locator('body').innerText()).trim();
  console.log(`RENDERED_BODY_TEXT<<${text}>>`);
  console.log(`API_CALLS ${JSON.stringify(api)}`);
  await page.screenshot({ path: process.env.JOURNEY_SHOT ?? 'journey.png' });
  expect(api.length).toBeGreaterThan(0);
  for (const c of api) {
    expect(c.release).toMatch(/^r[1-9][0-9]*\.[0-9a-f]{12}$/);
    expect(c.status).toBeLessThan(500);
  }
  expect(foreign).toEqual([]);
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
