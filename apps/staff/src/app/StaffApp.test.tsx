import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellRuntime } from '@ehr/app-shell';
import { StaffApp } from './StaffApp.js';

afterEach(cleanup);

interface Seen {
  method: string;
  path: string;
}
function setup(opts: {
  status?: number;
  roles?: string[];
  audience?: string;
  idleInMs?: number;
  signOutStatus?: number;
  rolesReadEmpty?: boolean;
}) {
  let sessionReads = 0;
  const seen: Seen[] = [];
  const assign = vi.fn();
  const runtime = createShellRuntime({
    clientRelease: 'r5.bbbbbbbbbbbb',
    baseUrl: 'http://portal.test',
    afterSignOut: () => assign('/signed-out'),
    fetch: async (r) => {
      const path = new URL(r.url).pathname;
      seen.push({ method: r.method, path });
      if (path.endsWith('/auth/session') && r.method === 'GET') {
        sessionReads += 1;
        if (opts.rolesReadEmpty === true && sessionReads === 2)
          return new Response(null, { status: 204 });
        if ((opts.status ?? 200) !== 200)
          return new Response(JSON.stringify({ code: 'auth.unauthenticated' }), { status: 401 });
        const idle = new Date(Date.now() + (opts.idleInMs ?? 30 * 60_000)).toISOString();
        return new Response(
          JSON.stringify({
            principalId: '11111111-1111-4111-8111-111111111111',
            realm: 'staff',
            audience: opts.audience ?? 'google',
            displayName: 'Dr Test',
            csrfToken: 'csrf-1',
            idleExpiresAt: idle,
            roles: (opts.roles ?? ['doctor']).map((key) => ({
              key,
              locationId: '22222222-2222-4222-8222-222222222222',
            })),
            permissions: [],
            patients: [],
          }),
          { status: 200, headers: { 'X-Session-Idle-Expires-At': idle } },
        );
      }
      if (path.endsWith('/auth/sign-out'))
        return new Response(null, { status: opts.signOutStatus ?? 204 });
      if (path.endsWith('/auth/session/extend')) {
        const idle = new Date(Date.now() + 30 * 60_000).toISOString();
        return new Response(JSON.stringify({ idleExpiresAt: idle }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  });
  return { runtime, seen, assign };
}

function at(path: string, search = '') {
  window.history.replaceState(null, '', path + search);
}

beforeEach(() => at('/'));

describe('sign-in screen (SH-03)', () => {
  it('offers Continue with Google only, no password, and the plain contact-IT message', () => {
    at('/sign-in');
    const { runtime, assign } = setup({});
    const { container } = render(<StaffApp runtime={runtime} assign={assign} />);
    const link = screen.getByRole('link', { name: 'Continue with Google' });
    expect(link).toHaveAttribute('href', '/api/v1/auth/sign-in');
    expect(container.querySelector('input')).toBeNull();
    expect(screen.queryByText(/password/i)).toBeNull();
    expect(screen.getByTestId('not-enrolled')).toHaveTextContent('Contact IT');
    expect(screen.queryByText('We could not sign you in')).toBeNull();
  });
  it('shows the notice when a sign-in came back with a problem', () => {
    at('/sign-in', '?problem=1&returnTo=/schedule');
    render(<StaffApp runtime={setup({}).runtime} />);
    expect(screen.getByText('We could not sign you in')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/v1/auth/sign-in?returnTo=%2Fschedule',
    );
  });
  it('never forwards a returnTo that is not a known screen', () => {
    at('/sign-in', '?returnTo=/patients/abc?name=Jane');
    render(<StaffApp runtime={setup({}).runtime} />);
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/v1/auth/sign-in',
    );
  });
  it('makes no API call while signed out of the portal', () => {
    at('/sign-in');
    const { runtime, seen, assign } = setup({});
    render(<StaffApp runtime={runtime} assign={assign} />);
    expect(seen).toEqual([]);
  });
});

describe('signed-out screen (SH-06)', () => {
  it('says so and offers sign in again', () => {
    at('/signed-out');
    render(<StaffApp runtime={setup({}).runtime} />);
    expect(screen.getByRole('heading', { name: 'You have signed out' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/sign-in');
  });
});

describe('session gate and role navigation', () => {
  it('sends an unauthenticated visitor to sign-in, keeping only a known screen path', async () => {
    at('/schedule');
    const { runtime, assign } = setup({ status: 401 });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sign-in?returnTo=%2Fschedule'));
  });
  it('drops an unknown path or identifier on the way to sign-in', async () => {
    at('/patients/9f2c');
    const { runtime, assign } = setup({ status: 401 });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sign-in'));
  });
  it('shows the Doctor navigation to a doctor and lands on the first screen', async () => {
    const { runtime, assign } = setup({ roles: ['doctor'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    const nav = await screen.findByRole('navigation', { name: 'Staff portal' });
    const wide = within(nav).getAllByRole('list')[0]!;
    expect(
      within(wide)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Alerts', 'Schedule', 'Patients', 'Tasks & messages', 'Notes to sign']);
    // Phone bar is Alerts · Schedule · Patients · More (UI-UX 3.2)
    const phone = within(nav).getAllByRole('list')[1]!;
    expect(
      within(phone)
        .getAllByRole('link')
        .slice(0, 3)
        .map((a) => a.textContent),
    ).toEqual(['Alerts', 'Schedule', 'Patients']);
    expect(within(phone).getByText('More')).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/schedule'));
    expect(await screen.findByRole('heading', { name: 'Schedule today' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Schedule' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
  it('shows a retryable error, not "contact IT", when the roles read returns no data', async () => {
    const { runtime, assign } = setup({ roles: ['doctor'], rolesReadEmpty: true });
    render(<StaffApp runtime={runtime} assign={assign} />);
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/No staff screens/i)).not.toBeInTheDocument();
  });
  it('shows the Help link on public pages, loading and the signed-in shell', async () => {
    at('/sign-in');
    const a = render(<StaffApp runtime={setup({}).runtime} assign={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
    a.unmount();
    at('/signed-out');
    const b = render(<StaffApp runtime={setup({}).runtime} assign={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Help' })).toBeInTheDocument();
    b.unmount();
    at('/');
    const { runtime, assign } = setup({ roles: ['doctor'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation', { name: 'Staff portal' });
    expect(screen.getByRole('link', { name: 'Help' })).toBeInTheDocument();
  });
  it('shows the Pre-consultation navigation to front desk, not the Doctor one', async () => {
    const { runtime, assign } = setup({ roles: ['front_desk'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation', { name: 'Staff portal' });
    expect(screen.getAllByRole('link', { name: 'Arrivals' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Notes to sign' })).toBeNull();
  });
  it('says plainly when no screen is assigned', async () => {
    const { runtime, assign } = setup({ roles: ['mystery'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    expect(await screen.findByText(/No staff screens are assigned/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('gives an administrator session no staff navigation', async () => {
    const { runtime, assign } = setup({ roles: ['org_admin'], audience: 'admin_pool' });
    render(<StaffApp runtime={runtime} assign={assign} />);
    expect(await screen.findByText(/Staff screens are not available/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('a path outside the map is a plain not-found page', async () => {
    at('/patients/9f2c');
    const { runtime, assign } = setup({ roles: ['doctor'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: /can't find this/i }),
    ).toBeInTheDocument();
  });
  it('navigation keeps the URL to a fixed path', async () => {
    const { runtime, assign } = setup({ roles: ['doctor'] });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation');
    fireEvent.click(screen.getAllByRole('link', { name: 'Alerts' })[0]!);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/alerts',
    );
  });
});

describe('idle warning and sign-out', () => {
  it('warns before expiry and extends only when asked', async () => {
    const { runtime, seen, assign } = setup({ idleInMs: 90_000 });
    render(<StaffApp runtime={runtime} assign={assign} />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/signed out in/);
    expect(seen.some((s) => s.path.endsWith('/extend'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(seen.filter((s) => s.path.endsWith('/extend'))).toHaveLength(1);
  });
  it('shows the session-ended dialog when the deadline has passed and goes to sign-in', async () => {
    at('/alerts');
    const { runtime, assign } = setup({ idleInMs: 1_200 });
    render(<StaffApp runtime={runtime} assign={assign} />);
    const dialog = await screen.findByRole('alertdialog', undefined);
    await waitFor(
      () => expect(screen.getByRole('alertdialog')).toHaveTextContent('Your session ended'),
      {
        timeout: 4000,
      },
    );
    void dialog;
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(assign).toHaveBeenCalledWith('/sign-in?returnTo=%2Falerts');
  });
  it('sign out posts once, then leaves for the signed-out screen', async () => {
    const { runtime, seen, assign } = setup({});
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation');
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/signed-out'));
    expect(seen.filter((s) => s.method === 'POST' && s.path.endsWith('/sign-out'))).toHaveLength(1);
  });
  it('a failed sign-out does not claim the user is signed out', async () => {
    const { runtime, assign } = setup({ signOutStatus: 500 });
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation');
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(await screen.findByText('You have not been signed out')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('no PHI in URLs', () => {
  it('no API call carries anything but fixed paths', async () => {
    const { runtime, seen, assign } = setup({});
    render(<StaffApp runtime={runtime} assign={assign} />);
    await screen.findByRole('navigation');
    await act(async () => {});
    for (const s of seen) expect(s.path).toMatch(/^\/api\/v1\/auth\/[a-z/-]+$/);
  });
});
