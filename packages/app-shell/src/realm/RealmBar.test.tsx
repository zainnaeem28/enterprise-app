import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../session/session-store.js';
import { RealmBar } from './RealmBar.js';
import { realmKind } from './realm.js';

afterEach(cleanup);

// Real pairs: `PrincipalRealm` with its `AUDIENCE_OF` audience (apps/api/src/modules/identity/types.ts);
// the admin sign-in stores realm `admin_pool`, audience `staff` (identity/admin/session.ts).
describe('realmKind', () => {
  it.each([
    ['google', 'staff', 'staff'],
    ['admin_pool', 'staff', 'admin'],
    ['patient_pool', 'patient', 'patient'],
    ['partner_pool', 'partner', 'partner'],
  ])('realm %s with audience %s is %s', (realm, audience, kind) => {
    expect(realmKind({ realm, audience })).toBe(kind);
  });

  it.each([
    ['no session', undefined],
    ['empty session', {}],
    ['audience only', { audience: 'staff' }],
    ['invented realm admin', { realm: 'admin' }],
    ['invented realm staff', { realm: 'staff', audience: 'staff' }],
    ['upper-case realm', { realm: 'ADMIN_POOL', audience: 'staff' }],
    ['admin realm, patient audience', { realm: 'admin_pool', audience: 'patient' }],
    ['staff realm, admin_pool audience', { realm: 'google', audience: 'admin_pool' }],
    ['missing audience', { realm: 'admin_pool' }],
    ['prototype key', { realm: 'constructor', audience: 'staff' }],
  ])('%s is unknown', (_name, session) => {
    expect(realmKind(session)).toBe('unknown');
  });
});

function bar(realm: 'staff' | 'admin') {
  const signOut = vi.fn(async () => true);
  const store = new SessionStore({ extend: async () => ({ ok: false, expired: false }), signOut });
  render(<RealmBar realm={realm} productName="Clinic" displayName="Dr Sample" store={store} />);
  return signOut;
}

describe('RealmBar', () => {
  it('names the staff realm and offers the switch as a sign-out', async () => {
    const signOut = bar('staff');
    expect(screen.getByText('Staff portal')).toBeInTheDocument();
    expect(screen.queryByText(/Administrator sign-in/)).toBeNull();
    expect(
      screen.getByText(/kept as a draft where the screen supports drafts/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out to switch to administrator' }));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });

  it('always shows the fixed admin banner', () => {
    bar('admin');
    expect(screen.getByText('Administrator portal')).toBeInTheDocument();
    expect(
      screen.getByText('Administrator sign-in. Clinical data is not available here.'),
    ).toBeInTheDocument();
  });
});
