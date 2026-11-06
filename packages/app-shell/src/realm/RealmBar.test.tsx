import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../session/session-store.js';
import { RealmBar } from './RealmBar.js';
import { realmKind } from './realm.js';

afterEach(cleanup);

describe('realmKind', () => {
  it('tells the staff and admin pools apart', () => {
    expect(realmKind({ audience: 'google' })).toBe('staff');
    expect(realmKind({ audience: 'admin_pool' })).toBe('admin');
    expect(realmKind({ audience: 'patient' })).toBe('patient');
    expect(realmKind(undefined)).toBe('unknown');
    expect(realmKind({ audience: 'my-staff-admin-x' })).toBe('unknown');
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
