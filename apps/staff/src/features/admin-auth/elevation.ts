import { adminElevate } from './api.js';
import type { Failure } from './api.js';
import type { ShellRuntime } from '@ehr/app-shell';
import type { SecurityKey } from './webauthn.js';

/** What the dialog tells the administrator before they touch the key (UI-UX 3.1): the action, its target and who approves. */
export interface ElevationRequest {
  action: string;
  target: string;
  /** Who must approve. `null` when the step needs no second approver. */
  approver: string | null;
}

/**
 * The elevation grant this tab knows about, in memory only (never storage). The server owns the truth: a privileged route answers
 * 403 `identity.elevation_required` once the grant is gone (removal of a role, kill switch, expiry), and `callPrivileged` then asks
 * again. There is no state endpoint yet (UX-A-18), so the chip shows the expiry time the last successful ceremony returned.
 */
export class ElevationStore {
  private expiresAt: number | undefined;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  /** Epoch ms while the grant is live, otherwise undefined. */
  getSnapshot = (): number | undefined => (this.live() ? this.expiresAt : undefined);

  private live() {
    return this.expiresAt !== undefined && this.expiresAt > this.now();
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  grant(iso: string) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return;
    this.expiresAt = t;
    clearTimeout(this.timer);
    const left = t - this.now();
    // setTimeout caps near 24.8 days; a grant is minutes, but never overflow the timer.
    if (left > 0) this.timer = setTimeout(() => this.emit(), Math.min(left, 2 ** 31 - 1));
    this.emit();
  }
  /** The server refused with `identity.elevation_required`, or the session ended. */
  clear() {
    clearTimeout(this.timer);
    this.expiresAt = undefined;
    this.emit();
  }
  isLive = () => this.live();
}

export type ElevateResult = { ok: true; elevationExpiresAt: string } | Failure;

export function createElevation(
  runtime: Pick<ShellRuntime, 'api'>,
  key: SecurityKey,
  store: ElevationStore,
) {
  return {
    store,
    async elevate(signal?: AbortSignal): Promise<ElevateResult> {
      const r = await adminElevate(runtime.api, key, signal);
      if (!r.ok) return r;
      store.grant(r.value.elevationExpiresAt);
      return { ok: true, elevationExpiresAt: r.value.elevationExpiresAt };
    },
  };
}
export type Elevation = ReturnType<typeof createElevation>;

export const ELEVATION_REQUIRED = 'identity.elevation_required';

/** True for the answer of a privileged route whose grant is missing or gone: 403 `identity.elevation_required`. */
export function isElevationRequired(result: { response: Response; error?: unknown }): boolean {
  if (result.response.status !== 403) return false;
  return (result.error as { code?: unknown } | undefined)?.code === ELEVATION_REQUIRED;
}
