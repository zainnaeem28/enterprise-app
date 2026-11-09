import { releaseNumberFromManifest, parseClientRelease } from './client-release.js';

export const POLL_INTERVAL_MS = 5 * 60 * 1000;
export const REMIND_LATER_MS = 30 * 60 * 1000;

/** A form with unsaved input, registered in memory only (never persisted, UI-UX 7.7 rule 2). */
export interface UnsavedForm {
  name: string;
  /** Present only where the server has a draft route. Reload happens after it resolves true. */
  saveDraft?: () => Promise<boolean>;
}

export interface ReleaseState {
  newerAvailable: boolean;
  remindedUntil: number;
  refused: boolean;
  keepOpen: boolean;
  requestId?: string;
  forms: readonly UnsavedForm[];
}

export interface ReleaseStoreOptions {
  clientRelease: string;
  fetchManifest?: () => Promise<unknown>;
  now?: () => number;
  reload?: () => void;
}

const defaultManifest = async (): Promise<unknown> => {
  // Same-origin static file; no cookie, no API route, so it never touches the idle timer.
  const r = await fetch('/release.json', { cache: 'no-cache', credentials: 'omit' });
  if (!r.ok) throw new Error(`release.json ${r.status}`);
  return r.json();
};

export class ReleaseStore {
  private state: ReleaseState = {
    newerAvailable: false,
    remindedUntil: 0,
    refused: false,
    keepOpen: false,
    forms: [],
  };
  private listeners = new Set<() => void>();
  private readonly own: number;
  private readonly fetchManifest: () => Promise<unknown>;
  private readonly now: () => number;
  private readonly doReload: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ReleaseStoreOptions) {
    const own = parseClientRelease(options.clientRelease);
    if (own === undefined) throw new Error('Malformed client release');
    this.own = own;
    this.fetchManifest = options.fetchManifest ?? defaultManifest;
    this.now = options.now ?? Date.now;
    this.doReload = options.reload ?? (() => window.location.reload());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<ReleaseState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Reads release.json once. A failed poll is silent: the blocking dialog is the safety net. */
  async poll(): Promise<void> {
    try {
      const n = releaseNumberFromManifest(await this.fetchManifest());
      if (n !== undefined && n > this.own) this.set({ newerAvailable: true });
    } catch {
      /* ignore */
    }
  }

  /** Every 5 minutes and when the tab regains focus. Returns a stop function. */
  start(): () => void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(this.timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }

  /** The bar shows unless reminded-later; a refused call brings the blocking dialog regardless. */
  barVisible(): boolean {
    const s = this.state;
    return s.newerAvailable && !s.refused && this.now() >= s.remindedUntil;
  }

  remindLater() {
    this.set({ remindedUntil: this.now() + REMIND_LATER_MS });
  }

  refuse(requestId?: string) {
    this.set({ refused: true, ...(requestId === undefined ? {} : { requestId }) });
  }

  keepPageOpen() {
    this.set({ keepOpen: true });
  }

  setForms(forms: readonly UnsavedForm[]) {
    this.set({ forms });
  }

  reload() {
    this.doReload();
  }

  /** Reload after the server confirms the draft saves; stays put if any save fails. */
  async saveDraftsAndReload(): Promise<boolean> {
    for (const f of this.state.forms) {
      if (f.saveDraft === undefined) continue;
      if (!(await f.saveDraft())) return false;
    }
    this.doReload();
    return true;
  }
}
