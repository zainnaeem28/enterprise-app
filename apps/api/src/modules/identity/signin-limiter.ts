// Per-IP sign-in failure counter (ARCHITECTURE 31.3, TDR-08 / TDR-13, SEC-01 RL-1..RL-4). Failures only: a success never
// counts. At the limit the callback answers 429 before doing any verification work. The count lives in
// `kernel.rate_counter` (PostgreSQL), so it holds across instances; keys are HMACs of the address, never the address. A
// failure is counted in its own short transaction AFTER the request's transaction has rolled back, so the count survives
// the rollback. A refusal never locks out a principal; it only throttles one network.
import { createHmac } from 'node:crypto';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { KernelDb } from '@ehr/kernel';
import { RateLimitedError } from './errors.js';

export const WINDOW_MS = 5 * 60_000;
export const DEFAULT_IP_FAILURES = 50;
export const DEFAULT_CLINIC_IP_FAILURES = 200;
/** Global failures per realm per window that raise an operations alert (never a refusal). */
export const GLOBAL_ALERT_FAILURES = 300;

export interface SignInLimiterDeps {
  db: KernelDb;
  orgId: string;
  /** `<env>/app/rate-key`: its own secret (31.3). */
  hmacKey: string;
  now?: () => number;
  /** Called when a realm's global failure count reaches 300 in a window. Must not throw. */
  onGlobalAlert?: (info: { realm: string; failures: number }) => void;
}

interface Limits {
  ipFailures: number;
  clinicIpFailures: number;
  clinic: BlockList;
}

const intIn = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : dflt;

/** Same validation as the IaC check (31.3 (b)): refuse IPv4 shorter than /24, IPv6 shorter than /48 and non-public ranges. */
export function parseClinicCidrs(value: unknown): BlockList {
  const list = new BlockList();
  if (!Array.isArray(value)) return list;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const [addr, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (addr === undefined || !Number.isInteger(bits)) continue;
    if (isIPv4(addr) && bits >= 24 && bits <= 32 && !privateV4(addr))
      list.addSubnet(addr, bits, 'ipv4');
    else if (isIPv6(addr) && bits >= 48 && bits <= 128 && !/^(::1?|f[cd]|fe[89ab])/i.test(addr))
      list.addSubnet(addr, bits, 'ipv6');
  }
  return list;
}

function privateV4(a: string): boolean {
  const [o1 = 0, o2 = 0] = a.split('.').map(Number);
  return (
    o1 === 10 ||
    o1 === 127 ||
    o1 === 0 ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 169 && o2 === 254) ||
    o1 >= 224
  );
}

export class SignInLimiter {
  constructor(private readonly d: SignInLimiterDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private key(kind: string, value: string): string {
    return `${kind}:${createHmac('sha256', this.d.hmacKey).update(value).digest('hex')}`;
  }
  private windowStart(): number {
    return Math.floor(this.now() / WINDOW_MS) * WINDOW_MS;
  }

  private async limits(): Promise<Limits> {
    return this.d.db.withScope({ audience: 'anonymous', orgId: this.d.orgId }, async (tx) => {
      const { rows } = await tx.query(
        `SELECT key, value FROM kernel.setting WHERE pre_auth AND location_id IS NULL
            AND key IN ('signin_ip_failures', 'signin_clinic_ip_failures', 'clinic_egress_cidrs')`,
      );
      const by = new Map(rows.map((r) => [r['key'] as string, r['value']]));
      return {
        ipFailures: intIn(by.get('signin_ip_failures'), DEFAULT_IP_FAILURES),
        clinicIpFailures: intIn(by.get('signin_clinic_ip_failures'), DEFAULT_CLINIC_IP_FAILURES),
        clinic: parseClinicCidrs(by.get('clinic_egress_cidrs')),
      };
    });
  }

  /** Throws RateLimitedError (429) when this address is at its limit. Runs before any verification. */
  async assertAllowed(ip: string): Promise<void> {
    const limits = await this.limits();
    const type = isIPv6(ip) ? 'ipv6' : 'ipv4';
    const clinic = (isIPv4(ip) || isIPv6(ip)) && limits.clinic.check(ip, type);
    const limit = clinic ? limits.clinicIpFailures : limits.ipFailures;
    const start = this.windowStart();
    const count = await this.d.db.withScope(
      { audience: 'anonymous', orgId: this.d.orgId },
      async (tx) => {
        const r = await tx.query(
          `SELECT count FROM kernel.rate_counter WHERE key = $1 AND window_start = to_timestamp($2 / 1000.0)`,
          [this.key('signin_ip', ip), start],
        );
        return Number(r.rows[0]?.['count'] ?? 0);
      },
    );
    if (count >= limit)
      throw new RateLimitedError(Math.max(1, Math.ceil((start + WINDOW_MS - this.now()) / 1000)));
  }

  /** One failure, in its own transaction. Never throws: a counting failure must not hide the original refusal. */
  async recordFailure(ip: string, realm: string): Promise<void> {
    const start = this.windowStart();
    try {
      const global = await this.d.db.withScope(
        { audience: 'anonymous', orgId: this.d.orgId },
        async (tx) => {
          let last = 0;
          for (const k of [this.key('signin_ip', ip), this.key('signin_global', realm)]) {
            const r = await tx.query(
              `INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count)
             VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
             ON CONFLICT (organisation_id, key, window_start) DO UPDATE SET count = kernel.rate_counter.count + 1, updated_at = now()
             RETURNING count`,
              [this.d.orgId, k, start],
            );
            last = Number(r.rows[0]?.['count'] ?? 0);
          }
          return last;
        },
      );
      if (global === GLOBAL_ALERT_FAILURES) this.d.onGlobalAlert?.({ realm, failures: global });
    } catch {
      // swallowed on purpose; the caller logs the class of the original failure
    }
  }
}
