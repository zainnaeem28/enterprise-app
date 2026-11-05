// Rate limits (ARCHITECTURE 31.3, CN-11). Per principal at the API: in memory per instance for general traffic
// (limit divided by the instance count, so the total is approximate) and in PostgreSQL for the security-critical
// routes, where the limit must hold exactly across instances. The WAF per-IP layer is outside this process.
import { createHmac } from 'node:crypto';
import type { KernelDb } from '@ehr/kernel';
import { ApiError } from './errors.js';
import type { Next, Req, Res } from './http.js';
import { sendProblem } from './respond.js';

export interface Hit {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number, now?: number): Promise<Hit>;
}

const MAX_KEYS = 50_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly instanceCount = 1) {}

  hit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<Hit> {
    const effective = Math.max(1, Math.floor(limit / this.instanceCount));
    const start = Math.floor(now / windowMs) * windowMs;
    const w = this.windows.get(key);
    const cur = w !== undefined && w.start === start ? w : { start, count: 0 };
    cur.count += 1;
    this.windows.set(key, cur);
    if (this.windows.size > MAX_KEYS) this.sweep(start);
    return Promise.resolve({
      allowed: cur.count <= effective,
      retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
    });
  }

  /** Drop older windows; if the current window alone is over the cap, evict the oldest keys down to half the cap
   * so the next sweeps are amortised O(1) per hit rather than a scan on every request. */
  private sweep(currentStart: number): void {
    for (const [k, w] of this.windows) if (w.start < currentStart) this.windows.delete(k);
    if (this.windows.size <= MAX_KEYS) return;
    let drop = this.windows.size - MAX_KEYS / 2;
    for (const k of this.windows.keys()) {
      if (drop-- <= 0) break;
      this.windows.delete(k); // Map iterates in insertion order: oldest first
    }
  }
}

/** Exact across instances: one atomic upsert on `kernel.rate_counter` (RLS: organisation only, TDR-08). */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly db: KernelDb,
    private readonly orgId: string,
    /** Keys are keyed hashes (policy comment on kernel.rate_counter): no identifier is stored in clear. */
    private readonly keySecret: string,
  ) {
    if (keySecret.length < 16)
      throw new Error('rate-limit key secret must be at least 16 characters');
  }

  async hit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<Hit> {
    const start = Math.floor(now / windowMs) * windowMs;
    const hashed = createHmac('sha256', this.keySecret).update(key).digest('hex');
    const count = await this.db.withScope(
      { audience: 'anonymous', orgId: this.orgId },
      async (tx) => {
        const r = await tx.query(
          `INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
         ON CONFLICT (organisation_id, key, window_start)
         DO UPDATE SET count = kernel.rate_counter.count + 1, updated_at = now()
         RETURNING count`,
          [this.orgId, hashed, start],
        );
        return Number((r.rows[0] as { count: unknown }).count);
      },
    );
    return {
      allowed: count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
    };
  }
}

export interface RouteClassLimit {
  limit: number;
  windowMs: number;
}

/** 31.3: portal reads 300 / min, writes 60 / min, per principal. */
export const CLASS_LIMITS: Record<'read' | 'write', RouteClassLimit> = {
  read: { limit: 300, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
};

/** The principal id when a session resolved one (identity, later); the source IP otherwise. */
export function limiterKey(req: Req, cls: string): string {
  const principal = (req as { principalId?: string }).principalId;
  return principal !== undefined
    ? `principal:${principal}:${cls}`
    : `ip:${req.ip ?? 'unknown'}:${cls}`;
}

export function rateLimitMiddleware(limiter: RateLimiter) {
  return (req: Req, res: Res, next: Next): void => {
    const cls = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    const { limit, windowMs } = CLASS_LIMITS[cls];
    limiter
      .hit(limiterKey(req, cls), limit, windowMs)
      .then((h) => {
        if (h.allowed) return next();
        sendProblem(
          req,
          res,
          new ApiError(429, 'kernel.rate_limited', true, {
            retryAfterSeconds: h.retryAfterSeconds,
          }),
        );
      })
      .catch(next);
  };
}
