// Portal/API release contract (ARCHITECTURE 28.6, AL-04). Checked after route matching and before the session
// lookup, CSRF, the guard, idempotency and the handler: a refused request reads no table and writes nothing.
import { ApiError } from './errors.js';
import { hostOf } from './http.js';
import type { Next, Req, Res } from './http.js';
import type { PlatformConfig } from './config.js';
import { sendProblem } from './respond.js';

const HEADER_RE = /^r([1-9][0-9]{0,9})\.[0-9a-f]{12}$/;

/** `r<releaseNumber>.<sha12>` -> releaseNumber, or undefined when malformed. */
export function parseClientRelease(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = HEADER_RE.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Closed exemption list (28.6), matched on the route template, never on a client header. */
const EXEMPT: readonly { method: string; re: RegExp }[] = [
  { method: 'GET', re: /^\/api\/v1\/auth\/sign-in$/ },
  { method: 'GET', re: /^\/api\/v1\/auth\/callback$/ },
  { method: 'GET', re: /^\/api\/v1\/calendar-link\/callback$/ },
  { method: 'GET', re: /^\/api\/v1\/appointments\/[^/]+\/calendar\.ics$/ },
  { method: 'GET', re: /^\/healthz$/ },
  { method: 'GET', re: /^\/readyz$/ },
];

export const STREAM_PATH = '/api/v1/alerts/stream';

export interface ReleaseMetrics {
  refused(releaseNumber: number | 'missing' | 'malformed'): void;
}

export function isReleaseChecked(req: Req, cfg: PlatformConfig): boolean {
  // Express matches routes case-insensitively, so the comparison is too: `/API/v1/...` must not escape the check.
  const path = req.path.toLowerCase();
  if (!path.startsWith('/api/')) return false; // health and any non-API path
  if (hostOf(req).startsWith(cfg.integrationsHostPrefix)) return false; // the whole integrations. host
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  return !EXEMPT.some((e) => e.method === method && e.re.test(path));
}

export function clientReleaseMiddleware(cfg: PlatformConfig, metrics: ReleaseMetrics) {
  return (req: Req, res: Res, next: Next): void => {
    if (!isReleaseChecked(req, cfg)) return next();
    // EventSource cannot send headers: the stream takes the same value as a query parameter (28.6).
    const raw =
      req.path.toLowerCase() === STREAM_PATH
        ? (req.query['clientRelease'] ?? req.header('x-client-release'))
        : req.header('x-client-release');
    const n = parseClientRelease(raw);
    if (n === undefined) {
      metrics.refused(raw === undefined ? 'missing' : 'malformed');
    } else if (n < cfg.minClientRelease) {
      metrics.refused(n);
    } else {
      return next();
    }
    sendProblem(req, res, new ApiError(400, 'kernel.client_release_unsupported', false));
  };
}
