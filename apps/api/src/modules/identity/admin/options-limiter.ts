// The `options` counter of ARCHITECTURE 31.3 (SEC01-F-02; T-2): EVERY admin sign-in or enrolment options call counts,
// success or not, per source address. The increment is the handler's first statement; at the limit the route answers
// 429 kernel.rate_limited with Retry-After, without reading an identity table or inserting a challenge. 30 per 5 minutes
// (Setting `signin_options_ip_limit`), 200 from `clinic_egress_cidrs` (`signin_clinic_options_ip_limit`). The count is in
// `kernel.rate_counter`, so it holds across instances; the key is an HMAC of the address, never the address.
import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { KernelDb } from '@ehr/kernel';
import { RateLimitedError } from '../errors.js';
import { parseClinicCidrs, WINDOW_MS } from '../signin-limiter.js';

export const DEFAULT_OPTIONS_LIMIT = 30;
export const DEFAULT_CLINIC_OPTIONS_LIMIT = 200;
/** Global options calls per window that raise an operations alert (never a refusal). */
export const GLOBAL_OPTIONS_ALERT = 3000;

const intIn = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : dflt;

export interface OptionsLimiterDeps {
  db: KernelDb;
  orgId: string;
  hmacKey: string;
  now?: () => number;
  onGlobalAlert?: (info: { count: number }) => void;
}

export class OptionsLimiter {
  constructor(private readonly d: OptionsLimiterDeps) {}

  private key(kind: string, value: string): string {
    return `${kind}:${createHmac('sha256', this.d.hmacKey).update(value).digest('hex')}`;
  }

  /** Counts this call and throws {@link RateLimitedError} when the address is over its limit. */
  async hit(ip: string): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const { count, global, limit } = await this.d.db.withScope(
      { audience: 'anonymous', orgId: this.d.orgId },
      async (tx) => {
        const bump = async (k: string): Promise<number> => {
          const r = await tx.query(
            `INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count)
             VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
             ON CONFLICT (organisation_id, key, window_start) DO UPDATE SET count = kernel.rate_counter.count + 1, updated_at = now()
             RETURNING count`,
            [this.d.orgId, k, start],
          );
          return Number(r.rows[0]?.['count'] ?? 0);
        };
        const count = await bump(this.key('options', ip));
        const global = await bump(this.key('options_global', 'admin_pool'));
        const s = await tx.query(
          `SELECT key, value FROM kernel.setting WHERE pre_auth AND location_id IS NULL
              AND key IN ('signin_options_ip_limit', 'signin_clinic_options_ip_limit', 'clinic_egress_cidrs')`,
        );
        const by = new Map(s.rows.map((r) => [r['key'] as string, r['value']]));
        const type = isIPv6(ip) ? 'ipv6' : 'ipv4';
        const clinic =
          (isIPv4(ip) || isIPv6(ip)) &&
          parseClinicCidrs(by.get('clinic_egress_cidrs')).check(ip, type);
        const limit = clinic
          ? intIn(by.get('signin_clinic_options_ip_limit'), DEFAULT_CLINIC_OPTIONS_LIMIT)
          : intIn(by.get('signin_options_ip_limit'), DEFAULT_OPTIONS_LIMIT);
        return { count, global, limit };
      },
    );
    if (global === GLOBAL_OPTIONS_ALERT) this.d.onGlobalAlert?.({ count: global });
    if (count > limit)
      throw new RateLimitedError(Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000)));
  }
}
