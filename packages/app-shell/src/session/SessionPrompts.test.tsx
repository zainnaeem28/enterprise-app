import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPrompts } from './SessionPrompts.js';
import { SessionStore } from './session-store.js';
import type { ExtendResult } from './session-store.js';
import { sessionStrings as s } from './strings.js';

const T0 = Date.parse('2026-01-01T09:00:00Z');
const MIN = 60_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(
  extendResult: ExtendResult = { ok: true, idleExpiresAt: new Date(T0 + 40 * MIN).toISOString() },
) {
  const extend = vi.fn(async () => extendResult);
  const signOut = vi.fn(async () => {});
  const store = new SessionStore({ extend, signOut });
  const onSignIn = vi.fn();
  const view = render(
    <>
      <button>page control</button>
      <SessionPrompts store={store} onSignIn={onSignIn} />
    </>,
  );
  store.setIdleExpiresAt(new Date(T0 + 15 * MIN).toISOString());
  return { store, extend, signOut, onSignIn, view };
}

const open = () => act(() => void vi.advanceTimersByTime(13 * MIN));

describe('warning dialog', () => {
  it('opens at 13 minutes as an alertdialog with focus and a 2:00 countdown', () => {
    setup();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    open();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('You will be signed out in 2:00');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBeInTheDocument();
  });

  it('counts down visibly but announces the time only once', () => {
    setup();
    open();
    act(() => void vi.advanceTimersByTime(30_000));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('1:30');
    expect(dialog.querySelectorAll('[aria-live],[role=status],[role=timer]')).toHaveLength(0);
    expect(dialog).toHaveTextContent('You will be signed out in 2:00');
  });

  it('Stay signed in is the only thing that calls extend', async () => {
    const { extend } = setup();
    open();
    expect(extend).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' })));
    expect(extend).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape also stays signed in, so a screen-reader user is not trapped', async () => {
    const { extend } = setup();
    open();
    await act(async () => void fireEvent.keyDown(document, { key: 'Escape' }));
    expect(extend).toHaveBeenCalledOnce();
  });

  it('shows an alert when extending fails and keeps the dialog', async () => {
    setup({ ok: false, expired: false });
    open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' })));
    expect(screen.getByRole('alert')).toHaveTextContent(s.extendFailed);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('has no axe violations (jsdom: contrast and target size run in the browser suite)', async () => {
    const { view } = setup();
    open();
    const r = await (async () => {
      vi.useRealTimers();
      return axe.run(view.container.ownerDocument.body, {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
    })();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('session ended and held-back sign-out', () => {
  it('shows the 401 dialog and sends the user to sign-in', async () => {
    const { store, onSignIn } = setup();
    act(() => store.end());
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your session ended.');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('warns when a draft could not be saved and offers Sign out anyway', async () => {
    const { store, signOut } = setup();
    store.setForms([{ name: 'Visit note', saveDraft: async () => false }]);
    await act(async () => store.signOut());
    expect(screen.getByRole('alertdialog')).toHaveTextContent(s.signOutBlockedBody);
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: s.signOutAnyway })));
    expect(signOut).toHaveBeenCalledOnce();
  });
});
