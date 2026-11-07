// A software FIDO2 authenticator for the tests: a real P-256 key pair, real authenticator data, real ECDSA signatures and
// a hand-assembled packed SELF-attestation. This is test fixture code only; the verification under test is the library's.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// --- the smallest CBOR encoder that the fixture needs (unsigned/negative ints, byte/text strings, maps) ---------------
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  return Buffer.concat([head(2, v.length), Buffer.from(v)]);
}

const sha = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const;

export interface CeremonyOpts {
  origin: string;
  rpId: string;
  /** User verification flag; default true. */
  uv?: boolean;
  /** Backup eligible / backed up flags; default false. */
  be?: boolean;
  bs?: boolean;
  /** The signature counter written into authenticator data. */
  counter?: number;
  /** Overrides the challenge the authenticator signs (a replayed or wrong challenge). */
  challenge?: string;
  /** Attestation only. */
  aaguid?: string;
}

const uuidBytes = (u: string): Buffer => Buffer.from(u.replace(/-/g, ''), 'hex');

export class SoftKey {
  readonly credentialId: Buffer;
  private readonly priv: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  counter = 0;

  constructor(credentialId?: Buffer) {
    this.credentialId = credentialId ?? randomBytes(32);
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = kp.privateKey;
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.x = Buffer.from(jwk.x, 'base64url');
    this.y = Buffer.from(jwk.y, 'base64url');
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  private clientData(
    type: 'webauthn.create' | 'webauthn.get',
    challengeB64: string,
    origin: string,
  ): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge: challengeB64, origin, crossOrigin: false }),
    );
  }

  private flags(o: CeremonyOpts, extra = 0): number {
    return (
      FLAG.UP |
      ((o.uv ?? true) ? FLAG.UV : 0) |
      (o.be === true ? FLAG.BE : 0) |
      (o.bs === true ? FLAG.BS : 0) |
      extra
    );
  }

  private counterBytes(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  }

  /** `navigator.credentials.get` for the request options the server returned. */
  assert(options: { challenge: string }, o: CeremonyOpts): Record<string, unknown> {
    this.counter = o.counter ?? this.counter + 1;
    const authData = Buffer.concat([
      sha(o.rpId),
      Buffer.from([this.flags(o)]),
      this.counterBytes(this.counter),
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.get',
      o.challenge ?? options.challenge,
      o.origin,
    );
    const signature = sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.priv);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }

  /** `navigator.credentials.create` for the creation options the server returned: packed self-attestation. */
  create(options: { challenge: string }, o: CeremonyOpts): Record<string, unknown> {
    this.counter = o.counter ?? 0;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha(o.rpId),
      Buffer.from([this.flags(o, FLAG.AT)]),
      this.counterBytes(this.counter),
      uuidBytes(o.aaguid ?? '00000000-0000-0000-0000-000000000000'),
      len,
      this.credentialId,
      cose,
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.create',
      o.challenge ?? options.challenge,
      o.origin,
    );
    const sig = sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.priv);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'packed'],
        [
          'attStmt',
          new Map<Cbor, Cbor>([
            ['alg', -7],
            ['sig', sig],
          ]),
        ],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['usb'],
      },
    };
  }
}
