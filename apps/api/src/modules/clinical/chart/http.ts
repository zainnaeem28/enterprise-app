// Small HTTP helpers shared by the chart controllers: the problem+json aware `send`, the weak ETag, and the idempotent write wrapper
// of 28.3 (the key row is inserted first in the business transaction, so a concurrent duplicate waits and then replays).
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { requireAuthContext } from '../../identity/index.js';
import type { RequestMeta } from './types.js';

export const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

export const send = (
  res: Res,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

export const etag = (version: number): string => `W/"${version}"`;

export interface Fresh {
  status: number;
  body: unknown;
  location?: string;
  headers?: Record<string, string>;
}

export async function idempotentWrite(
  db: KernelDb,
  req: Req,
  res: Res,
  template: string,
  pathParams: string[],
  handler: (tx: Tx) => Promise<Fresh>,
): Promise<void> {
  let key: string;
  try {
    key = parseIdempotencyKey(req.header('idempotency-key'));
  } catch {
    throw new ApiError(400, 'kernel.idempotency_key_required');
  }
  const hash = requestHash({
    method: req.method,
    routeTemplate: template,
    pathParams,
    query: {},
    body: req.body,
  });
  const out = await db.withScope(
    requireAuthContext(req).scope,
    async (tx) => {
      const begun = await beginIdempotent(tx, template, key, hash);
      if (begun.kind === 'replay') return { kind: 'replay' as const, replay: begun.response };
      const fresh = await handler(tx);
      await completeIdempotent(tx, template, key, {
        status: fresh.status,
        body: Buffer.from(JSON.stringify(fresh.body)),
        ...(fresh.location === undefined ? {} : { location: fresh.location }),
      });
      return { kind: 'fresh' as const, fresh };
    },
    { idempotent: true },
  );
  if (out.kind === 'replay') {
    const r = out.replay;
    res.setHeader('Idempotent-Replay', 'true');
    if (r.location !== null) res.setHeader('Location', r.location);
    send(res, r.status, r.body === null ? {} : JSON.parse(r.body.toString('utf8')));
    return;
  }
  if (out.fresh.location !== undefined) res.setHeader('Location', out.fresh.location);
  send(res, out.fresh.status, out.fresh.body, out.fresh.headers);
}
