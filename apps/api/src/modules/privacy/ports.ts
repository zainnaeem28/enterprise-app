// What the privacy module needs from outside (ARCHITECTURE 25.10, 24). The API never reads or writes package content: it presigns a
// short-lived URL and nothing else (the documents store's rule, CN-12). The worker has its own port with content access
// (apps/worker/src/jobs/privacy/ports.ts). A real adapter (S3 with the KMS key) is delivered at staging with the bucket, which does not
// exist yet (C-01); the in-memory ones used by the tests prove nothing about the real store.
import { createHmac } from 'node:crypto';

export interface PresignedGet {
  url: string;
  expiresAt: Date;
}

export interface PackageStorePort {
  /** A URL for one object, valid for `expiresSeconds`; the object is an encrypted package (server-side encryption at the store). */
  presignGet(key: string, expiresSeconds: number, now: Date): PresignedGet;
}

/** A test and development presigner: the URL names the key and an expiry and carries an HMAC. Not evidence about a real store. */
export class SignedPackageUrls implements PackageStorePort {
  constructor(
    private readonly secret: Buffer,
    private readonly origin = 'https://objects.invalid',
  ) {}

  presignGet(key: string, expiresSeconds: number, now: Date): PresignedGet {
    const exp = Math.floor(now.getTime() / 1000) + expiresSeconds;
    const sig = createHmac('sha256', this.secret).update(`GET\n${key}\n${exp}`).digest('hex');
    return {
      url: `${this.origin}/${key}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000),
    };
  }
}

/**
 * The assembler's write access to the package store (the worker side; the API has none). The object is written under the key given
 * (random, `p/<32 hex>`, no PHI) and must be encrypted at rest by the store (server-side encryption with the KMS key; the key and the
 * bucket do not exist until C-01, so what the in-memory test store does proves nothing about encryption).
 */
export interface PackageWriterPort {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}
