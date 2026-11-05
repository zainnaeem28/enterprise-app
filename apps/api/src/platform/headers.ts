// Request id (CN-13), Cache-Control (CN-10) and the absence of CORS (28.6) for every response.
import { randomUUID } from 'node:crypto';
import type { Next, Req, Res } from './http.js';

const INBOUND_ID = /^[A-Za-z0-9-]{8,64}$/;

export const isPublicApi = (path: string): boolean => path.startsWith('/public/v1/');

export function baselineHeaders(req: Req, res: Res, next: Next): void {
  const inbound = req.header('x-request-id');
  req.requestId = inbound !== undefined && INBOUND_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', isPublicApi(req.path) ? 'public, max-age=60' : 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Same-origin API (ADR-005): no Access-Control-* header may leave this process, whatever a handler or library sets.
  const set = res.setHeader.bind(res);
  res.setHeader = (name: string, value: string | number | readonly string[]): unknown =>
    /^access-control-/i.test(name) ? res : set(name, value);
  next();
}
