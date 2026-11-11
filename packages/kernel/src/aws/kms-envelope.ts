// KMS envelope sealer/opener shared by the API (seal) and the worker (open) (AWS-BE-2; ARCHITECTURE SC-3, DF-4). A payload is
// encrypted with AES-256-GCM (context and embedded key id as additional authenticated data) under a fresh data key from KMS GenerateDataKey. The KMS encryption context AND the GCM additional
// authenticated data both carry the caller's context string (purpose, organisation, record id), so a blob cannot be opened for another
// record. Sealed blob layout (big endian), all inside the authenticated envelope except the KMS-wrapped key, which KMS authenticates:
//   magic "EHK1" | u16 keyIdLen | keyId | u16 edkLen | encryptedDataKey | 12-byte iv | 16-byte tag | ciphertext
// The key id of the key that wrapped the data key is embedded, so a rotation (a new KEY_ID) never strands old blobs: the opener asks KMS
// to decrypt with the embedded id, provided it is one the process is configured to trust. No plaintext data key outlives a call.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  DescribeKeyCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';

const MAGIC = Buffer.from('EHK1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_PLAIN = 1024 * 1024;

/** Raised for any refusal. The message never contains plaintext, context, key bytes or the blob. */
export class KmsEnvelopeError extends Error {
  constructor(readonly reason: 'malformed' | 'untrusted_key' | 'open_failed' | 'too_large') {
    super(`payload envelope refused: ${reason}`);
    this.name = 'KmsEnvelopeError';
  }
}

export interface KmsEnvelopeConfig {
  /** Key id, key ARN or alias used to seal. */
  keyId: string;
  /** Other keys whose blobs may still be opened (rotation window). Ids, ARNs or aliases. */
  previousKeyIds?: readonly string[];
}

// `arn:aws:kms:r:acct:key/<id>` or a bare `<id>` -> `<id>`; an alias (`alias/x`, `arn:...:alias/x`) is returned as-is.
const tail = (id: string): string =>
  id.includes(':key/') ? id.slice(id.indexOf(':key/') + 5) : id;
const isAlias = (id: string): boolean => id.startsWith('alias/') || id.includes(':alias/');

// GCM additional data: the context and the embedded key id, length-prefixed so the two cannot be shifted into each other.
function aadOf(context: string, keyId: string): Buffer {
  const c = Buffer.from(context, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(c.length);
  return Buffer.concat([len, c, Buffer.from(keyId, 'utf8')]);
}

function ctxOf(context: string): Record<string, string> {
  if (context === '') throw new KmsEnvelopeError('malformed');
  return { 'ehr:ctx': context };
}

export class KmsEnvelope {
  private trusted: Promise<Set<string>> | undefined;

  constructor(
    private readonly kms: Pick<KMSClient, 'send'>,
    private readonly cfg: KmsEnvelopeConfig,
  ) {
    if (cfg.keyId.trim() === '') throw new Error('KMS key id is required');
  }

  /** Key ids (tails of ARNs) this process opens; aliases are resolved once through DescribeKey. */
  private trustedKeys(): Promise<Set<string>> {
    return (this.trusted ??= (async () => {
      const out = new Set<string>();
      for (const id of [this.cfg.keyId, ...(this.cfg.previousKeyIds ?? [])]) {
        if (!isAlias(id)) {
          out.add(tail(id));
          continue;
        }
        const d = await this.kms.send(new DescribeKeyCommand({ KeyId: id }));
        const arn = d.KeyMetadata?.KeyId;
        if (arn === undefined) throw new Error('KMS alias did not resolve to a key');
        out.add(tail(arn));
      }
      return out;
    })().catch((e: unknown) => {
      this.trusted = undefined; // do not cache a failed resolution
      throw e;
    }));
  }

  async seal(plain: Buffer, context: string): Promise<Buffer> {
    if (plain.length > MAX_PLAIN) throw new KmsEnvelopeError('too_large');
    const ec = ctxOf(context);
    const dk = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.cfg.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: ec,
      }),
    );
    if (dk.Plaintext === undefined || dk.CiphertextBlob === undefined || dk.KeyId === undefined)
      throw new Error('KMS GenerateDataKey returned an incomplete response');
    // Copy so we can wipe our copy; the SDK's own buffer is wiped too.
    const key = Buffer.from(dk.Plaintext);
    try {
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
      c.setAAD(aadOf(context, dk.KeyId));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      const keyId = Buffer.from(dk.KeyId, 'utf8');
      const edk = Buffer.from(dk.CiphertextBlob);
      const head = Buffer.alloc(2);
      const mid = Buffer.alloc(2);
      head.writeUInt16BE(keyId.length);
      mid.writeUInt16BE(edk.length);
      return Buffer.concat([MAGIC, head, keyId, mid, edk, iv, c.getAuthTag(), ct]);
    } finally {
      key.fill(0);
      dk.Plaintext.fill(0);
    }
  }

  async open(sealed: Buffer, context: string): Promise<Buffer> {
    const ec = ctxOf(context);
    const p = parse(sealed);
    const trusted = await this.trustedKeys();
    if (!trusted.has(tail(p.keyId))) throw new KmsEnvelopeError('untrusted_key');
    let key: Buffer | undefined;
    try {
      const r = await this.kms.send(
        new DecryptCommand({ CiphertextBlob: p.edk, KeyId: p.keyId, EncryptionContext: ec }),
      );
      if (r.Plaintext === undefined) throw new KmsEnvelopeError('open_failed');
      key = Buffer.from(r.Plaintext);
      r.Plaintext.fill(0);
      if (key.length !== 32) throw new KmsEnvelopeError('open_failed');
      const d = createDecipheriv('aes-256-gcm', key, p.iv, { authTagLength: TAG_LEN });
      d.setAAD(aadOf(context, p.keyId));
      d.setAuthTag(p.tag);
      return Buffer.concat([d.update(p.ct), d.final()]);
    } catch (e) {
      // KMS context mismatch, tampered blob, wrong key and a failed GCM tag are all the same answer to the caller.
      if (e instanceof KmsEnvelopeError) throw e;
      throw new KmsEnvelopeError('open_failed');
    } finally {
      key?.fill(0);
    }
  }
}

function parse(b: Buffer): { keyId: string; edk: Buffer; iv: Buffer; tag: Buffer; ct: Buffer } {
  const bad = (): never => {
    throw new KmsEnvelopeError('malformed');
  };
  if (b.length < MAGIC.length + 2 || !b.subarray(0, MAGIC.length).equals(MAGIC)) return bad();
  let o = MAGIC.length;
  const idLen = b.readUInt16BE(o);
  o += 2;
  if (idLen === 0 || b.length < o + idLen + 2) return bad();
  const keyId = b.subarray(o, o + idLen).toString('utf8');
  o += idLen;
  const edkLen = b.readUInt16BE(o);
  o += 2;
  if (edkLen === 0 || b.length < o + edkLen + IV_LEN + TAG_LEN) return bad();
  const edk = b.subarray(o, o + edkLen);
  o += edkLen;
  const iv = b.subarray(o, o + IV_LEN);
  o += IV_LEN;
  const tag = b.subarray(o, o + TAG_LEN);
  o += TAG_LEN;
  return { keyId, edk, iv, tag, ct: b.subarray(o) };
}
