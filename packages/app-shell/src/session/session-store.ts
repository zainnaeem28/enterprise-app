import type { UnsavedForm } from '../release/release-store.js';

/** The warning opens this long before `idleExpiresAt`: 13 of the 15 staff minutes (UI-UX 7.1, ARCH 26.2). */
export const WARN_BEFORE_MS = 2 * 60 * 1000;

export type SessionPhase = 'active' | 'warning' | 'ended';

export interface SessionState {
  phase: SessionPhase;
  /** Whole seconds until idle expiry while `phase` is `warning`. */
  secondsLeft: number;
  extendFailed: boolean;
  /** Sign-out was held back because a draft could not be saved; the user may sign out anyway. */
  signOutBlocked: boolean;
}

export type ExtendResult = { ok: true; idleExpiresAt: string } | { ok: false; expired: boolean };

export interface SessionStoreOptions {
  /** `POST /auth/session/extend`. Called only from `extend()`, which only the prompt's button calls. */
  extend: () => Promise<ExtendResult>;
  /** `POST /auth/sign-out`. */
  signOut: () => Promise<void>;
  /** Where to go after sign-out completes (the sign-in page). */
  afterSignOut?: () => void;
  now?: () => number;
}

/**
 * Idle-timeout state for one tab. The server owns the deadline: it arrives in `X-Session-Idle-Expires-At`
 * on every response. This store makes no API call on a timer (26.2: passive traffic must not extend the
 * session); the only call it can make is `extend`, from the prompt button.
 */
export class SessionStore {
  private state: SessionState = {
    phase: 'active',
    secondsLeft: 0,
    extendFailed: false,
    signOutBlocked: false,
  };
  private listeners = new Set<() => void>();
  private expiresAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private forms: readonly UnsavedForm[] = [];
  private readonly now: () => number;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Forms with unsaved input; those with `saveDraft` are saved before a deliberate sign-out. */
  setForms(forms: readonly UnsavedForm[]) {
    this.forms = forms;
  }

  /** Feed the server deadline (response header, `GET /auth/session`, extend response). */
  setIdleExpiresAt(iso: string) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || this.state.phase === 'ended') return;
    this.expiresAt = t;
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    const expiresAt = this.expiresAt;
    if (expiresAt === undefined) return;
    const left = expiresAt - this.now();
    if (left <= 0) return this.end();
    if (left <= WARN_BEFORE_MS) {
      this.set({ phase: 'warning', secondsLeft: Math.ceil(left / 1000) });
      this.timer = setTimeout(() => this.schedule(), 1000);
    } else {
      if (this.state.phase !== 'active') this.set({ phase: 'active', extendFailed: false });
      this.timer = setTimeout(() => this.schedule(), left - WARN_BEFORE_MS);
    }
  }

  /** The server said the session is gone (401 `auth.session_expired`) or the deadline passed. */
  end() {
    clearTimeout(this.timer);
    this.expiresAt = undefined;
    this.set({ phase: 'ended' });
  }

  /** "Stay signed in": the only caller of `POST /auth/session/extend`. */
  async extend(): Promise<void> {
    const result = await this.options.extend();
    if (result.ok) {
      this.set({ extendFailed: false });
      this.setIdleExpiresAt(result.idleExpiresAt);
    } else if (result.expired) this.end();
    else this.set({ extendFailed: true });
  }

  /**
   * Deliberate sign-out (also the realm switch). Drafts that have a server route are saved first (X-20);
   * if a save fails nothing is signed out until the user chooses "Sign out anyway" (`force`).
   */
  async signOut(force = false): Promise<void> {
    if (!force) {
      for (const f of this.forms) {
        if (f.saveDraft === undefined) continue;
        let saved = false;
        try {
          saved = await f.saveDraft();
        } catch {
          /* treated as not saved */
        }
        if (!saved) return this.set({ signOutBlocked: true });
      }
    }
    try {
      await this.options.signOut();
    } finally {
      this.set({ signOutBlocked: false });
      clearTimeout(this.timer);
      this.options.afterSignOut?.();
    }
  }

  cancelSignOut() {
    this.set({ signOutBlocked: false });
  }

  /** Forms that have unsaved input and no draft route: they are lost on sign-out and the UI says so. */
  unsavedWithoutDraft(): string[] {
    return this.forms.filter((f) => f.saveDraft === undefined).map((f) => f.name);
  }

  stop() {
    clearTimeout(this.timer);
  }
}
