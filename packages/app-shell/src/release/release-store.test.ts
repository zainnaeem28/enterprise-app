import { describe, expect, it, vi } from 'vitest';
import { parseClientRelease, releaseNumberFromManifest } from './client-release.js';
import { REMIND_LATER_MS, ReleaseStore } from './release-store.js';

const RELEASE = 'r10.aaaaaaaaaaaa';

describe('client release parsing', () => {
  it('parses and rejects like the API', () => {
    expect(parseClientRelease('r142.3f9a1c2b7d10')).toBe(142);
    for (const bad of ['', 'r0.3f9a1c2b7d10', 'r1.3F9A1C2B7D10', 'r1.abc', '1.3f9a1c2b7d10'])
      expect(parseClientRelease(bad)).toBeUndefined();
  });
  it('reads release_number from the manifest', () => {
    expect(releaseNumberFromManifest({ release_number: 11 })).toBe(11);
    expect(releaseNumberFromManifest({ release_number: '11' })).toBeUndefined();
    expect(releaseNumberFromManifest(null)).toBeUndefined();
  });
});

function make(manifest: unknown, now = { t: 0 }) {
  const reload = vi.fn();
  const store = new ReleaseStore({
    clientRelease: RELEASE,
    fetchManifest: async () => manifest,
    now: () => now.t,
    reload,
  });
  return { store, reload, now };
}

describe('ReleaseStore', () => {
  it('shows the bar only for a higher release number', async () => {
    const same = make({ release_number: 10 });
    await same.store.poll();
    expect(same.store.barVisible()).toBe(false);
    const newer = make({ release_number: 11 });
    await newer.store.poll();
    expect(newer.store.barVisible()).toBe(true);
  });

  it('stays silent when the poll fails', async () => {
    const store = new ReleaseStore({
      clientRelease: RELEASE,
      fetchManifest: async () => {
        throw new Error('offline');
      },
    });
    await store.poll();
    expect(store.getSnapshot().newerAvailable).toBe(false);
  });

  it('remind-me-later hides the bar for 30 minutes, in memory', async () => {
    const { store, now } = make({ release_number: 11 });
    await store.poll();
    store.remindLater();
    expect(store.barVisible()).toBe(false);
    now.t = REMIND_LATER_MS;
    expect(store.barVisible()).toBe(true);
  });

  it('a refused call hides the bar in favour of the blocking dialog', async () => {
    const { store } = make({ release_number: 11 });
    await store.poll();
    store.refuse('req-9');
    expect(store.getSnapshot()).toMatchObject({ refused: true, requestId: 'req-9' });
    expect(store.barVisible()).toBe(false);
  });

  it('never reloads by itself; draft save must succeed before reload', async () => {
    const { store, reload } = make({ release_number: 11 });
    await store.poll();
    expect(reload).not.toHaveBeenCalled();
    store.setForms([{ name: 'Visit note', saveDraft: async () => false }]);
    expect(await store.saveDraftsAndReload()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    store.setForms([{ name: 'Visit note', saveDraft: async () => true }]);
    expect(await store.saveDraftsAndReload()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('writes nothing to web storage', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    const { store } = make({ release_number: 11 });
    await store.poll();
    store.setForms([{ name: 'Message to clinic' }]);
    store.remindLater();
    expect(spy).not.toHaveBeenCalled();
  });
});
