import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { json, runtimeWith, SESSION } from './test-helpers.js';
import type { Respond } from './test-helpers.js';

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
    ['signin.cancelled', 'Sign-in was cancelled'],
    ['signin.expired', 'Your sign-in took too long'],
    ['identity.sign_in_failed', 'We could not sign you in'],
  ])('/problem?code=%s is reachable', async (code, title) => {
    window.history.replaceState(null, '', `/problem?code=${code}`);
    mount(happy);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });
});
