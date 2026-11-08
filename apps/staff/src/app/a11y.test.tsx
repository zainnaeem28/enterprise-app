// axe-core on the rendered sign-in, signed-out and signed-in shell in jsdom (no stylesheet or layout is applied, so
// colour-contrast and target-size rules run only in the Playwright spec of features/auth/e2e).
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellRuntime } from '@ehr/app-shell';
import { StaffApp } from './StaffApp.js';

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

function runtime(roles: string[], idleInMs = 30 * 60_000) {
  return createShellRuntime({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    fetch: async () => {
      const idle = new Date(Date.now() + idleInMs).toISOString();
      return new Response(
        JSON.stringify({
          principalId: '11111111-1111-4111-8111-111111111111',
          realm: 'staff',
          audience: 'google',
          displayName: 'Dr Test',
          csrfToken: 'c',
          idleExpiresAt: idle,
          roles: roles.map((key) => ({ key })),
          permissions: [],
          patients: [],
        }),
        { status: 200, headers: { 'X-Session-Idle-Expires-At': idle } },
      );
    },
  });
}

describe('axe on the staff shell (jsdom)', () => {
  it.each(['/sign-in', '/signed-out'])('%s', async (path) => {
    window.history.replaceState(null, '', path);
    const { container } = render(<StaffApp runtime={runtime([])} />);
    expect(await violations(container)).toEqual([]);
  });
  it('sign-in with the problem notice', async () => {
    window.history.replaceState(null, '', '/sign-in?problem=1');
    const { container } = render(<StaffApp runtime={runtime([])} />);
    expect(await violations(container)).toEqual([]);
  });
  it('signed-in doctor shell', async () => {
    window.history.replaceState(null, '', '/alerts');
    const { container } = render(<StaffApp runtime={runtime(['doctor'])} />);
    await screen.findByRole('navigation');
    expect(await violations(container)).toEqual([]);
  });
  it('signed-in shell with the idle warning open', async () => {
    window.history.replaceState(null, '', '/alerts');
    const { container } = render(<StaffApp runtime={runtime(['front_desk'], 90_000)} />);
    await screen.findByRole('alertdialog');
    expect(await violations(container)).toEqual([]);
  });
});
