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
          realm: 'google',
          audience: 'staff',
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

function adminRuntime() {
  return createShellRuntime({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    fetch: async (input) => {
      const idle = new Date(Date.now() + 30 * 60_000).toISOString();
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/auth/session'))
        return new Response(
          JSON.stringify({
            principalId: '11111111-1111-4111-8111-111111111111',
            realm: 'admin_pool',
            audience: 'staff',
            displayName: 'Admin Test',
            csrfToken: 'c',
            idleExpiresAt: idle,
            roles: [{ key: 'org_admin' }],
            permissions: [],
            patients: [],
          }),
          { status: 200, headers: { 'X-Session-Idle-Expires-At': idle } },
        );
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'X-Session-Idle-Expires-At': idle },
      });
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
  it('sign-in shows the Administrator sign-in link', async () => {
    window.history.replaceState(null, '', '/sign-in');
    const { container } = render(<StaffApp runtime={runtime([])} />);
    expect(screen.getByRole('link', { name: /administrator sign-in/i })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });
  it('administrator sign-in', async () => {
    window.history.replaceState(null, '', '/admin/sign-in');
    const { container } = render(<StaffApp runtime={runtime([])} />);
    expect(await violations(container)).toEqual([]);
  });
});

describe('axe on the administrator screens (jsdom)', () => {
  it.each([
    ['/admin/audit', 'Audit log'],
    ['/admin/btg', 'Break-the-glass review'],
    ['/admin/users', 'Users & roles'],
    ['/admin/privacy', 'Privacy requests'],
    ['/admin/clinics', 'Clinics, rooms, hours and holidays'],
    ['/admin/services', 'Services catalogue'],
    ['/admin/policies', 'Booking policies'],
    ['/admin/templates', 'Consent and questionnaire templates'],
    ['/admin/integrations', 'Integrations'],
    ['/admin/flags', 'Feature flags and banners'],
    ['/admin/vital-ranges', 'Vital-sign reference ranges'],
  ])('%s', async (path, heading) => {
    window.history.replaceState(null, '', path);
    const { container } = render(<StaffApp runtime={adminRuntime()} />);
    await screen.findByRole('heading', { level: 1, name: heading });
    expect(await violations(container)).toEqual([]);
  });
});
