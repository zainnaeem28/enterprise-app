import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { checkedReturnTo } from '../features/auth/returnTo.js';
import { json, runtimeWith, SESSION } from './test-helpers.js';
import type { Respond } from './test-helpers.js';

vi.mock('../features/previsit/index.js', async (orig) => ({
  ...(await orig<object>()),
  PrevisitRoutes: () => <p>route:previsit</p>,
}));
vi.mock('../features/telehealth/index.js', async (orig) => ({
  ...(await orig<object>()),
  TelehealthRoutes: (props: object) => (
    <p>route:telehealth{'onGrant' in props ? ' with onGrant' : ''}</p>
  ),
}));
vi.mock('../features/profile/index.js', async (orig) => ({
  ...(await orig<object>()),
  ProfileRoutes: () => <p>route:profile</p>,
}));
vi.mock('../features/privacy/index.js', async (orig) => ({
  ...(await orig<object>()),
  PrivacyRoutes: () => <p>route:privacy</p>,
}));
vi.mock('../features/messages/index.js', async (orig) => ({
  ...(await orig<object>()),
  MessagesRoutes: () => <p>route:messages</p>,
}));

afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, '', '/'));

function mount(respond: Respond) {
  const h = runtimeWith(respond);
  const assign = vi.fn();
  render(<App runtime={h.runtime} assign={assign} />);
  return { ...h, assign };
}
const redirect = () =>
  new Response(null, { status: 302, headers: { location: 'https://idp.example' } });

describe('entry, pre-redirect and handoff', () => {
  it('renders no password, OTP or MFA input', () => {
    mount(redirect);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it.each(['Sign in', 'Create account'])(
    '"%s" shows the message, then hands off to getAuthSignIn',
    async (label) => {
      const { assign, calls } = mount(redirect);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByText(/secure sign-in page/)).toBeInTheDocument();
      expect(screen.getByText(/passkey/)).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Continue to secure sign-in' }));
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('/api/v1/auth/sign-in?returnTo=%2Faccount'),
      );
      expect(calls).toEqual(['GET /api/v1/auth/sign-in?returnTo=%2Faccount']);
    },
  );

  it('never sends an unchecked returnTo', async () => {
    window.history.replaceState(null, '', '/continue?returnTo=https%3A%2F%2Fevil.example');
    const { assign } = mount(redirect);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to secure sign-in' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/api/v1/auth/sign-in?returnTo=%2Faccount'),
    );
  });

  it('shows the rate-limited state when sign-in is refused, and Try again asks again', async () => {
    let n = 0;
    const { assign } = mount(() =>
      n++ === 0 ? json(429, { code: 'kernel.rate_limited', requestId: 'q1' }) : redirect(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to secure sign-in' }));
    expect(await screen.findByRole('heading', { name: 'Too many attempts' })).toBeInTheDocument();
    expect(screen.getByText('q1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
  });
});

describe('landing after the callback', () => {
  const happy: Respond = (r) => {
    const path = new URL(r.url).pathname;
    if (path === '/api/v1/auth/session') return json(200, SESSION);
    if (path === '/api/v1/me') return json(200, { patients: [{ patientId: 'p1' }] });
    if (path === '/api/v1/auth/sign-out') return new Response(null, { status: 204 });
    return json(404, { code: 'kernel.not_found' });
  };

  it('starts the session and shows the signed-in principal', async () => {
    window.history.replaceState(null, '', '/account');
    const { calls } = mount(happy);
    expect(await screen.findByRole('heading', { name: 'You are signed in' })).toBeInTheDocument();
    expect(screen.getByText(/Test Patient/)).toBeInTheDocument();
    expect(calls).toEqual(['GET /api/v1/auth/session', 'GET /api/v1/me']);
  });

  const booking: Respond = (r) => {
    const path = new URL(r.url).pathname;
    if (path === '/api/v1/auth/session')
      return json(200, { ...SESSION, patients: [{ patientId: 'p1', relation: 'self' }] });
    if (path.endsWith('/appointments')) return json(200, { items: [] });
    if (path === '/api/v1/services' || path === '/api/v1/locations')
      return json(200, { items: [] });
    return happy(r);
  };

  it('links the landing page to the booking journey and mounts BookingRoutes on /book', async () => {
    window.history.replaceState(null, '', '/account');
    mount(booking);
    expect(await screen.findByRole('link', { name: 'My appointments' })).toHaveAttribute(
      'href',
      '/appointments',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Book an appointment' }));
    expect(window.location.pathname).toBe('/book');
    await waitFor(() => expect(document.title).toBe('Patient portal - Book: service'));
    expect(screen.queryByRole('heading', { name: 'You are signed in' })).toBeNull();
  });

  it('mounts the booking routes when opened directly', async () => {
    window.history.replaceState(null, '', '/appointments');
    mount(booking);
    await waitFor(() => expect(document.title).toBe('Patient portal - Appointments'));
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('offers no booking links when no patient is linked', async () => {
    window.history.replaceState(null, '', '/account');
    mount((r) =>
      new URL(r.url).pathname === '/api/v1/me' ? json(200, { patients: [] }) : happy(r),
    );
    await screen.findByText(/not linked to a patient record/);
    expect(screen.queryByRole('link', { name: 'Book an appointment' })).toBeNull();
  });

  it('shows a neutral state when no patient is linked and does not self-register', async () => {
    window.history.replaceState(null, '', '/account');
    const { calls } = mount((r) =>
      new URL(r.url).pathname === '/api/v1/me' ? json(200, { patients: [] }) : happy(r),
    );
    expect(await screen.findByText(/not linked to a patient record/)).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('signs out through POST /auth/sign-out with the in-memory CSRF token', async () => {
    window.history.replaceState(null, '', '/account');
    let csrf: string | null = null;
    const { navigations } = mount((r) => {
      if (new URL(r.url).pathname === '/api/v1/auth/sign-out') csrf = r.headers.get('x-csrf-token');
      return happy(r);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(navigations).toEqual(['/']));
    expect(csrf).toBe('csrf-test');
  });

  it('keeps tokens out of storage', async () => {
    window.history.replaceState(null, '', '/account');
    mount(happy);
    await screen.findByRole('heading', { name: 'You are signed in' });
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/csrf-test/);
  });

  it('a callback that left no session shows the sign-in-failed state', async () => {
    window.history.replaceState(null, '', '/account');
    mount(() => json(401, { code: 'auth.unauthenticated', requestId: 'q2' }));
    expect(
      await screen.findByRole('heading', { name: 'You are not signed in' }),
    ).toBeInTheDocument();
    expect(screen.getByText('q2')).toBeInTheDocument();
  });

  it.each([
    [429, 'kernel.rate_limited', 'Too many attempts'],
    [503, 'kernel.unavailable', 'Sign-in is not available right now'],
    [504, 'kernel.timeout', 'Sign-in took too long'],
    [409, 'patient.merged', 'This account was combined with another'],
  ])('session answer %i shows its own state', async (status, code, title) => {
    window.history.replaceState(null, '', '/account');
    mount(() => json(status, { code }));
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });

  it.each([
    [409, 'patient.merged', 'This account was combined with another'],
    [503, 'kernel.unavailable', 'Sign-in is not available right now'],
    [401, 'auth.unauthenticated', 'You are not signed in'],
  ])(
    'a valid session but GET /me answering %i shows its own state, not "not linked"',
    async (status, code, title) => {
      window.history.replaceState(null, '', '/account');
      mount((r) => (new URL(r.url).pathname === '/api/v1/me' ? json(status, { code }) : happy(r)));
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      expect(screen.queryByText(/not linked/)).not.toBeInTheDocument();
    },
  );

  it.each([
    ['signin.cancelled', 'Sign-in was cancelled'],
    ['signin.expired', 'Your sign-in took too long'],
    ['identity.sign_in_failed', 'We could not sign you in'],
  ])('/problem?code=%s is reachable', async (code, title) => {
    window.history.replaceState(null, '', `/problem?code=${code}`);
    mount(happy);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });
});

describe('patient-portal route sets (route components mocked)', () => {
  it.each([
    ['/appointments/0b1f4c2e-5d3a-4e6f-8a7b-9c0d1e2f3a4b/previsit', 'route:previsit'],
    ['/appointments/0b1f4c2e-5d3a-4e6f-8a7b-9c0d1e2f3a4b/video', 'route:telehealth'],
    ['/profile', 'route:profile'],
    ['/privacy', 'route:privacy'],
    ['/messages', 'route:messages'],
  ])('%s renders its route component', (path, text) => {
    window.history.replaceState(null, '', path);
    mount(redirect);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('an unknown path still renders the entry page', () => {
    window.history.replaceState(null, '', '/nothing-here');
    mount(redirect);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('BS-06 hand-off from the brand site', () => {
  const Q =
    '/book?serviceId=33333333-3333-4333-8333-333333333333&clinicianId=55555555-5555-4555-8555-555555555555';
  const signedOut: Respond = (r) => {
    const p = new URL(r.url).pathname;
    if (p.endsWith('/auth/session') || p.endsWith('/patients'))
      return json(401, { status: 401, code: 'auth.unauthenticated', requestId: 'req-1' });
    return json(404, { code: 'kernel.not_found' });
  };

  it('shows the interstitial and carries the full path with its query as returnTo', async () => {
    window.history.replaceState(null, '', Q);
    mount(signedOut);
    expect(
      await screen.findByRole('heading', {
        name: 'Sign in or create an account to finish booking',
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(window.location.pathname).toBe('/continue');
    const p = new URLSearchParams(window.location.search);
    expect(p.get('intent')).toBe('create');
    expect(checkedReturnTo(p.get('returnTo'))).toBe(Q);
  });
});
