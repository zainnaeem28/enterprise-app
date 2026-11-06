// Per-connection circuit state, in memory per instance (ARCHITECTURE 34.2): closed -> open after 5 consecutive failures
// or 50 % errors over the last 20 calls within 1 minute; open -> half-open after 30 s; half-open admits ONE probe call:
// success closes, failure re-opens. An open circuit fails fast; the shared state for the operations dashboard is written
// by the health check job (health.ts), not here.
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  consecutiveFailures: number;
  windowCalls: number;
  windowMs: number;
  errorRatio: number;
  openMs: number;
  now: () => number;
  onTransition?: (connectionId: string, from: CircuitState, to: CircuitState) => void;
}

export const DEFAULT_CIRCUIT: Omit<CircuitOptions, 'now'> = {
  consecutiveFailures: 5,
  windowCalls: 20,
  windowMs: 60_000,
  errorRatio: 0.5,
  openMs: 30_000,
};

interface Entry {
  state: CircuitState;
  consecutive: number;
  openedAt: number;
  probing: boolean;
  recent: { at: number; ok: boolean }[];
}

export class CircuitBreakers {
  private readonly entries = new Map<string, Entry>();
  private readonly opt: CircuitOptions;

  constructor(opt: Partial<CircuitOptions> = {}) {
    this.opt = { ...DEFAULT_CIRCUIT, now: Date.now, ...opt };
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (e === undefined) {
      e = { state: 'closed', consecutive: 0, openedAt: 0, probing: false, recent: [] };
      this.entries.set(id, e);
    }
    return e;
  }

  private move(id: string, e: Entry, to: CircuitState): void {
    const from = e.state;
    if (from === to) return;
    e.state = to;
    this.opt.onTransition?.(id, from, to);
  }

  state(id: string): CircuitState {
    const e = this.entries.get(id);
    if (e === undefined) return 'closed';
    if (e.state === 'open' && this.opt.now() - e.openedAt >= this.opt.openMs) return 'half_open';
    return e.state;
  }

  /** True when the call may go out. In half-open state exactly one call at a time is admitted. */
  admit(id: string): boolean {
    const e = this.entry(id);
    if (e.state === 'open') {
      if (this.opt.now() - e.openedAt < this.opt.openMs) return false;
      this.move(id, e, 'half_open');
      e.probing = false;
    }
    if (e.state === 'half_open') {
      if (e.probing) return false;
      e.probing = true;
    }
    return true;
  }

  /** A call that was admitted finished. `ok` false means a vendor-side failure (timeout, 5xx, network), not a 4xx. */
  record(id: string, ok: boolean): void {
    const e = this.entry(id);
    const now = this.opt.now();
    if (e.state === 'half_open') {
      e.probing = false;
      if (ok) {
        e.consecutive = 0;
        e.recent = [];
        this.move(id, e, 'closed');
      } else {
        e.openedAt = now;
        this.move(id, e, 'open');
      }
      return;
    }
    e.recent.push({ at: now, ok });
    e.recent = e.recent.filter((r) => now - r.at <= this.opt.windowMs).slice(-this.opt.windowCalls);
    e.consecutive = ok ? 0 : e.consecutive + 1;
    if (e.state !== 'closed') return;
    const failed = e.recent.filter((r) => !r.ok).length;
    const tripped =
      e.consecutive >= this.opt.consecutiveFailures ||
      (e.recent.length >= this.opt.windowCalls && failed / e.recent.length >= this.opt.errorRatio);
    if (tripped) {
      e.openedAt = now;
      this.move(id, e, 'open');
    }
  }

  /** A call was admitted but ended without an answer about the vendor (the caller aborted): release the probe slot. */
  release(id: string): void {
    const e = this.entries.get(id);
    if (e !== undefined) e.probing = false;
  }
}
