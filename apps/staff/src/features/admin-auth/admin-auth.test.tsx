import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@ehr/app-shell';
import {
  AdminRealmBar,
  AdminSignInLink,
  AdminSignInPage,
  ElevationChip,
  ElevationProvider,
  ElevationStore,
  adminAuthStrings as s,
  b64urlToBytes,
  bytesToB64url,
  createElevation,
  useElevation,
} from './index.js';
import type { ElevationRequest } from './index.js';
import { CHALLENGE, assertion, fakeKey, json, mockRuntime, optionsBody } from './testkit.js';

afterEach(cleanup);

const signInRoutes = (
  verify: Response = json(200, {
    principalId: 'p',
    csrfToken: 'c',
    idleExpiresAt: '2030-01-01T00:10:00Z',
  }),
) =>
  mockRuntime(({ path }) => {
    if (path.endsWith('/sign-in/options')) return json(200, optionsBody);
    if (path.endsWith('/sign-in/verify')) return verify.clone();
    return json(404, { code: 'kernel.not_found' });
  });

async function enterHandleAndSubmit(handle: string) {
  fireEvent.change(screen.getByLabelText(s.handleLabel), { target: { value: handle } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: s.useKey }));
  });
}

describe('base64url', () => {
  it('round-trips and refuses other alphabets', () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    expect(bytesToB64url(bytes)).toBe('-_8AAQI');
    expect([...b64urlToBytes('-_8AAQI')]).toEqual([...bytes]);
    expect(() => b64urlToBytes('a+b/')).toThrow();
  });
});

describe('Administrator sign-in (SH-04)', () => {
  it('has a security-key sign-in, no password and no Google button', () => {
    const { runtime } = signInRoutes();
    render(<AdminSignInPage runtime={runtime} securityKey={fakeKey().key} />);
    expect(screen.getByRole('heading', { name: 'Administrator sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with security key' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText(/Continue with Google/)).toBeNull();
  });

  it('runs options → key → verify with the lower-cased handle, then loads the admin landing screen', async () => {
    const { runtime, seen } = signInRoutes();
    const { key, calls } = fakeKey();
    const assign = vi.fn();
    render(<AdminSignInPage runtime={runtime} securityKey={key} assign={assign} />);
    await enterHandleAndSubmit('  Admin.One ');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /api/v1/admin/auth/sign-in/options',
      'POST /api/v1/admin/auth/sign-in/verify',
    ]);
    expect(seen[0]?.body).toEqual({ handle: 'admin.one' });
    expect(seen[1]?.body).toEqual({ challengeId: CHALLENGE, handle: 'admin.one', assertion });
    expect(seen[0]?.headers.get('x-client-release')).toBe('r5.bbbbbbbbbbbb');
    expect(calls).toHaveLength(1);
  });

  it('checks the handle format before any call', async () => {
    const { runtime, seen } = signInRoutes();
    render(<AdminSignInPage runtime={runtime} securityKey={fakeKey().key} />);
    await enterHandleAndSubmit('');
    expect(screen.getByText(s.handleRequired)).toBeInTheDocument();
    await enterHandleAndSubmit('a b');
    expect(screen.getByText(s.handleFormat)).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('answers every refusal the same way: unknown handle, wrong key, bad body', async () => {
    const same = async (r: ReturnType<typeof signInRoutes>, key = fakeKey().key) => {
      render(<AdminSignInPage runtime={r.runtime} securityKey={key} />);
      await enterHandleAndSubmit('admin.one');
      const text = (await screen.findByText(s.failedBody)).textContent;
      cleanup();
      return text;
    };
    const wrongKey = await same(signInRoutes(json(401, { code: 'identity.sign_in_failed' })));
    const optionsRefused = await same(
      mockRuntime(() => json(401, { code: 'identity.sign_in_failed' })),
    );
    const keyError = await same(signInRoutes(), fakeKey({ kind: 'error' }).key);
    const malformed = await same(mockRuntime(() => json(200, { nothing: true })));
    expect(new Set([wrongKey, optionsRefused, keyError, malformed]).size).toBe(1);
  });

  it('tells cancel, no-support, rate limit and outage apart from a refusal', async () => {
    const run = async (r: ReturnType<typeof signInRoutes>, key = fakeKey().key) => {
      render(<AdminSignInPage runtime={r.runtime} securityKey={key} />);
      await enterHandleAndSubmit('admin.one');
    };
    await run(signInRoutes(), fakeKey({ kind: 'cancelled' }).key);
    expect(await screen.findByText(s.cancelled)).toBeInTheDocument();
    cleanup();
    await run(signInRoutes(), fakeKey({ kind: 'unsupported' }).key);
    expect(await screen.findByText(s.unsupportedBody)).toBeInTheDocument();
    cleanup();
    await run(
      mockRuntime(() => json(429, { code: 'kernel.rate_limited' }, { 'Retry-After': '30' })),
    );
    expect(await screen.findByText(s.rateLimitedBody(30))).toBeInTheDocument();
    cleanup();
    await run(mockRuntime(() => json(503, { code: 'kernel.unavailable' })));
    expect(await screen.findByText(s.unavailableBody)).toBeInTheDocument();
    cleanup();
    await run(mockRuntime(() => Promise.reject(new TypeError('network'))));
    expect(await screen.findByText(s.unavailableBody)).toBeInTheDocument();
  });

  it('never sends the verify call when the key step did not produce an assertion', async () => {
    const { runtime, seen } = signInRoutes();
    render(<AdminSignInPage runtime={runtime} securityKey={fakeKey({ kind: 'cancelled' }).key} />);
    await enterHandleAndSubmit('admin.one');
    await screen.findByText(s.cancelled);
    expect(seen.map((x) => x.path)).toEqual(['/api/v1/admin/auth/sign-in/options']);
  });

  it('links to the staff sign-in, and the staff page links here', () => {
    const { runtime } = signInRoutes();
    render(
      <>
        <AdminSignInPage runtime={runtime} securityKey={fakeKey().key} />
        <AdminSignInLink />
      </>,
    );
    expect(screen.getByRole('link', { name: s.staffLink })).toHaveAttribute('href', '/sign-in');
    expect(screen.getByRole('link', { name: 'Administrator sign-in' })).toHaveAttribute(
      'href',
      '/admin/sign-in',
    );
  });
});

const REQUEST: ElevationRequest = {
  action: 'Change role',
  target: 'Dr A. Example: add Compliance officer',
  approver: 'A second administrator, not you',
};
const GRANT = new Date('2030-01-01T10:42:00Z').toISOString();

function elevationRoutes(verify: () => Response) {
  return mockRuntime(({ path }) => {
    if (path.endsWith('/elevation/options')) return json(200, optionsBody);
    if (path.endsWith('/elevation/verify')) return verify();
    return json(404, { code: 'kernel.not_found' });
  });
}

function Probe({ onResult }: { onResult: (v: unknown) => void }) {
  const { callPrivileged } = useElevation();
  return (
    <button
      onClick={() =>
        void callPrivileged(REQUEST, async () => {
          const r = { response: new Response(null, { status: 200 }) };
          return r;
        }).then(onResult)
      }
    >
      Do it
    </button>
  );
}

function setup(verify: () => Response, outcomes: Parameters<typeof fakeKey> = []) {
  const { runtime, seen } = elevationRoutes(verify);
  const store = new ElevationStore();
  const { key } = fakeKey(...outcomes);
  const elevation = createElevation(runtime, key, store);
  return { elevation, store, seen };
}

describe('elevation dialog', () => {
  it('names the action, the target and the approver, then closes on success and shows the chip', async () => {
    const { elevation, store, seen } = setup(() => json(200, { elevationExpiresAt: GRANT }));
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T10:27:00Z') });
    try {
      const done = vi.fn();
      render(
        <ElevationProvider elevation={elevation}>
          <ElevationChip store={store} format={() => '10:42'} />
          <Probe onResult={done} />
        </ElevationProvider>,
      );
      expect(screen.queryByText(/Elevated until/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
      const dialog = await screen.findByRole('alertdialog', { name: s.elevateTitle });
      expect(dialog).toHaveTextContent('Change role');
      expect(dialog).toHaveTextContent('Dr A. Example: add Compliance officer');
      expect(dialog).toHaveTextContent('A second administrator, not you');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: s.confirm }));
      });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.getByText('Elevated until 10:42')).toBeInTheDocument();
      await waitFor(() => expect(done).toHaveBeenCalledOnce());
      expect(seen[1]?.body).toEqual({ challengeId: CHALLENGE, assertion });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the dialog while a grant is live', async () => {
    const { elevation, store } = setup(() => json(200, { elevationExpiresAt: GRANT }));
    store.grant(new Date(Date.now() + 60_000).toISOString());
    const done = vi.fn();
    render(
      <ElevationProvider elevation={elevation}>
        <Probe onResult={done} />
      </ElevationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('stays open with one plain sentence when the key is refused, and cancel resolves undefined', async () => {
    const { elevation, store } = setup(() => json(401, { code: 'identity.elevation_failed' }));
    const done = vi.fn();
    render(
      <ElevationProvider elevation={elevation}>
        <Probe onResult={done} />
      </ElevationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: s.confirm }));
    });
    expect(await screen.findByText(s.elevateFailed)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(store.isLive()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: s.cancel }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(undefined));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('reports a cancelled key prompt without closing', async () => {
    const { elevation } = setup(
      () => json(200, { elevationExpiresAt: GRANT }),
      [{ kind: 'cancelled' }],
    );
    render(
      <ElevationProvider elevation={elevation}>
        <Probe onResult={() => undefined} />
      </ElevationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: s.confirm }));
    });
    expect(await screen.findByText(s.elevateCancelled)).toBeInTheDocument();
  });

  it('says so when no second approver is needed', async () => {
    const { elevation } = setup(() => json(200, { elevationExpiresAt: GRANT }));
    function NoApprover() {
      const { ensure } = useElevation();
      return <button onClick={() => void ensure({ ...REQUEST, approver: null })}>Go</button>;
    }
    render(
      <ElevationProvider elevation={elevation}>
        <NoApprover />
      </ElevationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText(s.noApprover)).toBeInTheDocument();
  });

  it('asks again and retries once when the server says the grant is gone (403 identity.elevation_required)', async () => {
    const { elevation, store } = setup(() =>
      json(200, { elevationExpiresAt: new Date(Date.now() + 900_000).toISOString() }),
    );
    store.grant(new Date(Date.now() + 60_000).toISOString());
    let calls = 0;
    function Retry({ onResult }: { onResult: (v: unknown) => void }) {
      const { callPrivileged } = useElevation();
      return (
        <button
          onClick={() =>
            void callPrivileged(REQUEST, async () => {
              calls += 1;
              return calls === 1
                ? {
                    response: new Response(null, { status: 403 }),
                    error: { code: 'identity.elevation_required' },
                  }
                : { response: new Response(null, { status: 200 }) };
            }).then(onResult)
          }
        >
          Retry
        </button>
      );
    }
    const done = vi.fn();
    render(
      <ElevationProvider elevation={elevation}>
        <Retry onResult={done} />
      </ElevationProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: s.confirm }));
    });
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(calls).toBe(2);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ response: { status: 200 } });
  });

  it('the chip disappears when the grant runs out', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T10:00:00Z') });
    try {
      const store = new ElevationStore();
      render(<ElevationChip store={store} format={() => '10:01'} />);
      act(() => store.grant('2030-01-01T10:01:00Z'));
      expect(screen.getByText('Elevated until 10:01')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.queryByText(/Elevated until/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('admin realm bar and realm switch', () => {
  function bar(signOut = vi.fn(async () => true)) {
    const session = new SessionStore({
      extend: async () => ({ ok: false, expired: false }),
      signOut,
    });
    const store = new ElevationStore();
    render(
      <AdminRealmBar
        runtime={{ session }}
        elevation={store}
        productName="Clinic"
        displayName="Admin One"
      />,
    );
    return { session, store, signOut };
  }

  it('shows the fixed admin banner and the realm in words', () => {
    bar();
    expect(
      screen.getByText('Administrator sign-in. Clinical data is not available here.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Administrator portal')).toBeInTheDocument();
  });

  it('shows the chip next to the banner only while elevated', () => {
    const { store } = bar();
    expect(screen.queryByText(/Elevated until/)).toBeNull();
    act(() => store.grant(new Date(Date.now() + 600_000).toISOString()));
    expect(screen.getByText(/^Elevated until \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('the switch is a sign-out that saves registered drafts first', async () => {
    const order: string[] = [];
    const { session } = bar(
      vi.fn(async () => {
        order.push('sign-out');
        return true;
      }),
    );
    session.setForms([
      { name: 'Role change note', saveDraft: async () => (order.push('save-draft'), true) },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out to switch to staff' }));
    await waitFor(() => expect(order).toEqual(['save-draft', 'sign-out']));
    expect(
      screen.getByText(/kept as a draft where the screen supports drafts/),
    ).toBeInTheDocument();
  });

  it('keeps the administrator signed in when a draft cannot be saved', async () => {
    const { session, signOut } = bar();
    session.setForms([{ name: 'Role change note', saveDraft: async () => false }]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out to switch to staff' }));
    await waitFor(() => expect(session.getSnapshot().signOutBlocked).toBe(true));
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a form with no draft route is named before it is lost', async () => {
    const { session, signOut } = bar();
    session.setForms([{ name: 'Export filters' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out to switch to staff' }));
    await waitFor(() => expect(session.getSnapshot().lossWarning).toEqual(['Export filters']));
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('axe (jsdom: contrast and target size run in the Playwright spec)', () => {
  async function violations(container: HTMLElement) {
    const r = await axe.run(container, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
  }

  it('sign-in page, with a failure', async () => {
    const { runtime } = signInRoutes(json(401, { code: 'identity.sign_in_failed' }));
    const { container } = render(<AdminSignInPage runtime={runtime} securityKey={fakeKey().key} />);
    expect(await violations(container)).toEqual([]);
    await enterHandleAndSubmit('admin.one');
    await screen.findByText(s.failedBody);
    expect(await violations(container)).toEqual([]);
  });

  it('elevation dialog with an error, and the admin bar with the chip', async () => {
    const { elevation, store } = setup(() => json(401, { code: 'identity.elevation_failed' }));
    const { container } = render(
      <ElevationProvider elevation={elevation}>
        <AdminRealmBar
          runtime={{
            session: new SessionStore({
              extend: async () => ({ ok: false, expired: false }),
              signOut: async () => true,
            }),
          }}
          elevation={store}
          productName="Clinic"
        />
        <Probe onResult={() => undefined} />
      </ElevationProvider>,
    );
    act(() => store.grant(new Date(Date.now() + 600_000).toISOString()));
    expect(await violations(container)).toEqual([]);
    act(() => store.clear());
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: s.confirm }));
    });
    await screen.findByText(s.elevateFailed);
    expect(await violations(container)).toEqual([]);
  });
});
