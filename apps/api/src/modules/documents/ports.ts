// The API tier's one outside dependency (ARCHITECTURE 25.10): the object store's presigner. The API never reads or writes file
// content: it hands the browser a short-lived URL and nothing else (CN-12, TC-DOC-05). The worker has its own port with content
// access (apps/worker/src/jobs/documents/ports.ts). A real adapter (S3 presigning) is delivered at staging with the bucket names
// and the KMS key, which do not exist yet (C-01); the in-memory one below is for tests and local development only and does not
// prove the real store.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Bucket = 'quarantine' | 'clean';

export interface PresignPut {
  bucket: Bucket;
  key: string;
  /** Fixed: the browser's request must carry exactly this Content-Type. */
  contentType: string;
  /** Fixed: the object store refuses any other Content-Length. */
  contentLength: number;
  expiresSeconds: number;
}

export interface PresignGet {
  bucket: Bucket;
  key: string;
  contentType: string;
  expiresSeconds: number;
}

export interface Presigned {
  url: string;
  /** Headers the browser must send with the request (PUT only). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStorePort {
  presignPut(req: PresignPut, now: Date): Presigned;
  presignGet(req: PresignGet, now: Date): Presigned;
}

/**
 * A test and development presigner. The URL names the bucket and key (random, no PHI) and carries an expiry and an HMAC over
 * method, bucket, key, expiry, type and length. `verify` is what a store would do: it is how the tests show that a URL is bound to
 * one object, one method and one moment.
 */
export class SignedUrlPresigner implements ObjectStorePort {
  constructor(
    private readonly secret: Buffer,
    private readonly origin = 'https://objects.invalid',
  ) {}

  private sign(
    method: 'PUT' | 'GET',
    bucket: string,
    key: string,
    exp: number,
    type: string,
    len: number,
  ): string {
    return createHmac('sha256', this.secret)
      .update(`${method}\n${bucket}\n${key}\n${exp}\n${type}\n${len}`)
      .digest('hex');
  }

  presignPut(req: PresignPut, now: Date): Presigned {
    const exp = Math.floor(now.getTime() / 1000) + req.expiresSeconds;
    const sig = this.sign('PUT', req.bucket, req.key, exp, req.contentType, req.contentLength);
    return {
      url: `${this.origin}/${req.bucket}/${req.key}?exp=${exp}&sig=${sig}`,
      headers: { 'Content-Type': req.contentType, 'Content-Length': String(req.contentLength) },
      expiresAt: new Date(exp * 1000),
    };
  }

  presignGet(req: PresignGet, now: Date): Presigned {
    const exp = Math.floor(now.getTime() / 1000) + req.expiresSeconds;
    const sig = this.sign('GET', req.bucket, req.key, exp, req.contentType, 0);
    return {
      url: `${this.origin}/${req.bucket}/${req.key}?exp=${exp}&sig=${sig}`,
      headers: {},
      expiresAt: new Date(exp * 1000),
    };
  }

  /** What the store checks on a request: false for a URL of another object, another method, a changed header or an expired one. */
  verify(
    method: 'PUT' | 'GET',
    url: string,
    actual: { contentType?: string; contentLength?: number },
    now: Date,
  ): boolean {
    const u = new URL(url);
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.join('/');
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    if (bucket === undefined || !Number.isFinite(exp) || Math.floor(now.getTime() / 1000) > exp)
      return false;
    const want = this.sign(
      method,
      bucket,
      key,
      exp,
      method === 'PUT' ? (actual.contentType ?? '') : (actual.contentType ?? ''),
      method === 'PUT' ? (actual.contentLength ?? -1) : 0,
    );
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(want, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
