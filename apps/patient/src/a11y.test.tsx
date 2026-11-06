// axe-core on the rendered pages in jsdom. jsdom applies no stylesheet or layout, so colour-contrast and
// target-size run in the Playwright spec on the built bundle (e2e/).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app/App.js';
import { json, runtimeWith, SESSION } from './app/test-helpers.js';
import type { Respond } from './app/test-helpers.js';

afterEach(cleanup);

async function violations(container: HTMLElement) {
  const r = await axe.run(container, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target).join(', ')}`,
  );
}

const signedIn: Respond = (r) =>
  new URL(r.url).pathname === '/api/v1/me' ? json(200, { patients: [] }) : json(200, SESSION);

describe('axe on the patient pages (jsdom)', () => {
  it('entry', async () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<App runtime={runtimeWith(signedIn).runtime} />);
    expect(await violations(container)).toEqual([]);
  });
  it('pre-redirect', async () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<App runtime={runtimeWith(signedIn).runtime} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/secure sign-in page/);
    expect(await violations(container)).toEqual([]);
  });
  it('landing', async () => {
    window.history.replaceState(null, '', '/account');
    const { container } = render(<App runtime={runtimeWith(signedIn).runtime} />);
    await screen.findByRole('heading', { name: 'You are signed in' });
    expect(await violations(container)).toEqual([]);
  });
  it.each([
    'kernel.validation_failed',
    'patient.merged',
    'kernel.rate_limited',
    'kernel.unavailable',
    'kernel.timeout',
    'kernel.not_found',
    'identity.sign_in_failed',
    'auth.unauthenticated',
    'auth.forbidden',
    'signin.cancelled',
    'signin.expired',
  ])('error page %s', async (code) => {
    window.history.replaceState(null, '', `/problem?code=${code}`);
    const { container } = render(<App runtime={runtimeWith(signedIn).runtime} />);
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });
});
