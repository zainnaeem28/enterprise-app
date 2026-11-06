import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore, WARN_BEFORE_MS } from './session-store.js';
import type { ExtendResult } from './session-store.js';

const T0 = Date.parse('2026-01-01T09:00:00Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function make(extendResult: ExtendResult = { ok: true, idleExpiresAt: iso(30 * MIN) }) {
  const extend = vi.fn(async () => extendResult);
  const signOut = vi.fn(async () => true);
  const afterSignOut = vi.fn();
  const store = new SessionStore({ extend, signOut, afterSignOut });
  return { store, extend, signOut, afterSignOut };
}

describe('idle warning', () => {
  it('opens at 13 of 15 minutes with 2:00 left', () => {
    const { store } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN - 1);
    expect(store.getSnapshot().phase).toBe('active');
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toMatchObject({ phase: 'warning', secondsLeft: 120 });
    expect(WARN_BEFORE_MS).toBe(120_000);
  });

  it('counts down and ends the session at the deadline', () => {
    const { store } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN + 30_000);
    expect(store.getSnapshot().secondsLeft).toBe(90);
    vi.advanceTimersByTime(90_000);
    expect(store.getSnapshot().phase).toBe('ended');
  });

  it('makes no API call on its own, whatever the elapsed time', () => {
    const { store, extend, signOut } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(20 * MIN);
    expect(extend).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a later server deadline (interactive traffic) cancels a warning', () => {
    const { store } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN + 1000);
    expect(store.getSnapshot().phase).toBe('warning');
    store.setIdleExpiresAt(iso(28 * MIN));
    expect(store.getSnapshot().phase).toBe('active');
  });

  it('ignores a malformed deadline', () => {
    const { store } = make();
    store.setIdleExpiresAt('soon');
    vi.advanceTimersByTime(60 * MIN);
    expect(store.getSnapshot().phase).toBe('active');
  });
});

describe('extend', () => {
  it('calls extend only when asked, then restarts the clock from the answer', async () => {
    const { store, extend } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN);
    await store.extend();
    expect(extend).toHaveBeenCalledOnce();
    expect(store.getSnapshot().phase).toBe('active');
    vi.advanceTimersByTime(14 * MIN);
    expect(store.getSnapshot().phase).toBe('active');
  });

  it('401 on extend ends the session; other failures keep the warning', async () => {
    const expired = make({ ok: false, expired: true });
    expired.store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN);
    await expired.store.extend();
    expect(expired.store.getSnapshot().phase).toBe('ended');

    vi.setSystemTime(T0);
    const down = make({ ok: false, expired: false });
    down.store.setIdleExpiresAt(iso(15 * MIN));
    vi.advanceTimersByTime(13 * MIN);
    await down.store.extend();
    expect(down.store.getSnapshot()).toMatchObject({ phase: 'warning', extendFailed: true });
  });
});

describe('sign-out keeps drafts (X-20)', () => {
  it('keeps the session and reports when sign-out fails', async () => {
    const { store, signOut, afterSignOut } = make();
    signOut.mockResolvedValue(false);
    await store.signOut();
    expect(afterSignOut).not.toHaveBeenCalled();
    expect(store.getSnapshot().signOutFailed).toBe(true);
  });

  it('saves server drafts first, then signs out', async () => {
    const { store, signOut, afterSignOut } = make();
    const order: string[] = [];
    store.setForms([
      {
        name: 'Visit note',
        saveDraft: async () => {
          order.push('save');
          return true;
        },
      },
    ]);
    signOut.mockImplementation(async () => {
      order.push('signOut');
      return true;
    });
    await store.signOut();
    expect(order).toEqual(['save', 'signOut']);
    expect(afterSignOut).toHaveBeenCalledOnce();
  });

  it('holds sign-out back when a draft cannot be saved, until the user forces it', async () => {
    const { store, signOut } = make();
    store.setForms([{ name: 'Visit note', saveDraft: async () => false }]);
    await store.signOut();
    expect(signOut).not.toHaveBeenCalled();
    expect(store.getSnapshot().signOutBlocked).toBe(true);
    await store.signOut(true);
    expect(signOut).toHaveBeenCalledOnce();
    expect(store.getSnapshot().signOutBlocked).toBe(false);
  });

  it('a throwing save counts as not saved; forms without a draft route are listed as lost', async () => {
    const { store, signOut } = make();
    store.setForms([
      {
        name: 'A',
        saveDraft: async () => {
          throw new Error('x');
        },
      },
      { name: 'Message to clinic' },
    ]);
    await store.signOut();
    expect(signOut).not.toHaveBeenCalled();
    expect(store.unsavedWithoutDraft()).toEqual(['Message to clinic']);
  });

  it('writes nothing to web storage', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    const { store } = make();
    store.setIdleExpiresAt(iso(15 * MIN));
    store.setForms([{ name: 'Visit note' }]);
    await store.signOut();
    expect(spy).not.toHaveBeenCalled();
  });
});
