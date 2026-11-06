// Signatures cover the bytes as received (verifiers.ts), so a parsed-and-reserialised body is never used. The bytes come from, in
// order: `req.rawBody` (set by the platform's JSON parser `verify` hook for `/webhooks/*`), or the request stream itself when no
// parser has consumed it (any non-JSON content type). A JSON body that was parsed with no copy kept cannot be verified: the request
// is answered 503 so the vendor retries, and nothing is stored (fail closed).
import { ApiError } from '../../platform/errors.js';
import type { Req } from '../../platform/http.js';

export const MAX_WEBHOOK_BODY_BYTES = 262_144; // 29.5: body <= 256 KB

interface Streamish {
  readable?: boolean;
  readableEnded?: boolean;
  complete?: boolean;
  destroy?(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export async function rawBodyOf(req: Req): Promise<Buffer> {
  const kept = (req as Req & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(kept)) return kept;
  const s = req as unknown as Streamish;
  if (s.readable !== true || s.readableEnded === true) {
    if (
      req.body === undefined ||
      (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length === 0)
    )
      return Buffer.alloc(0); // no body was sent
    throw new ApiError(503, 'kernel.unavailable', true); // parsed with no raw copy: cannot verify
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of s as AsyncIterable<Buffer | string>) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    size += b.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      throw new ApiError(413, 'kernel.payload_too_large');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
