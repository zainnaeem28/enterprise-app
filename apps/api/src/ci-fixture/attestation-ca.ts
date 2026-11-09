// CI-only synthetic FIDO attestation authority (INT04-F21). The admin realm accepts an enrolment only when the attestation chain
// ends in a root Cybersecurity approved (admin-env.ts, no default). A CI run that must complete the real admin sign-in in a headless
// browser therefore needs a root it can sign with. This file makes one PER RUN, in memory: a P-256 root and one leaf (the "model")
// that signs packed attestations. The private keys never leave the process that created them; only the root CERTIFICATE (public) is
// handed to the API through the normal EHR_ADMIN_ATTESTATION_ROOTS_PEM variable.
//
// Nothing here is reachable from the API entry point. The production guard is the other half: `loadAdminEnv` refuses a root whose
// subject carries CI_FIXTURE_ROOT_CN (or the fixture AAGUID) unless EHR_ENV=ci, so the fixture cannot be configured into staging or
// production even by mistake. Hand-assembled DER, no new dependency; the verification under test is the WebAuthn library's.
import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Subject common name of every fixture root. `admin-env.ts` matches on this text. */
export const CI_FIXTURE_ROOT_CN = 'EHR CI FIXTURE ROOT - NOT FOR PRODUCTION';
/** The one AAGUID the fixture authenticator reports. `admin-env.ts` refuses it outside EHR_ENV=ci. */
export const CI_FIXTURE_AAGUID = 'c1c1c1c1-0000-4000-8000-c1c1c1c1c1c1';

// --- minimal DER ----------------------------------------------------------------------------------------------------------
const len = (n: number): Buffer =>
  n < 128
    ? Buffer.from([n])
    : n < 256
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 127];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 127) | 128);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s));
const printable = (s: string): Buffer => tlv(0x13, Buffer.from(s));
const int = (b: Buffer): Buffer =>
  tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (d: Date): Buffer =>
  tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const ALG = seq(oid(ECDSA_SHA256));

const name = (cn: string, ou?: string): Buffer =>
  seq(
    set(seq(oid('2.5.4.6'), printable('XX'))),
    set(seq(oid('2.5.4.10'), utf8('EHR CI fixture'))),
    ...(ou === undefined ? [] : [set(seq(oid('2.5.4.11'), utf8(ou)))]),
    set(seq(oid('2.5.4.3'), utf8(cn))),
  );

function certificate(o: {
  subject: Buffer;
  issuer: Buffer;
  subjectKey: KeyObject;
  signingKey: KeyObject;
  ca: boolean;
  aaguid?: string;
}): Buffer {
  const spki = o.subjectKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const extensions = [
    seq(
      oid('2.5.29.19'), // basicConstraints, critical
      bool(true),
      octets(seq(...(o.ca ? [bool(true)] : []))),
    ),
    ...(o.aaguid === undefined
      ? []
      : [
          seq(
            oid('1.3.6.1.4.1.45724.1.1.4'), // id-fido-gen-ce-aaguid
            octets(octets(Buffer.from(o.aaguid.replace(/-/g, ''), 'hex'))),
          ),
        ]),
  ];
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // v3
    int(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ALG,
    o.issuer,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 7 * 86_400_000))),
    o.subject,
    spki,
    tlv(0xa3, seq(...extensions)),
  );
  const signer = createSign('sha256');
  signer.update(tbs);
  return seq(tbs, ALG, bits(signer.sign(o.signingKey)));
}

const pem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----`;

export interface AttestationFixture {
  /** Public root certificate: the only part that may be written to a file or an environment variable. */
  readonly rootPem: string;
  readonly aaguid: string;
  /** Private: signs attestations. Never serialised by this module. */
  readonly leafKey: KeyObject;
  /** `x5c` for `SoftKey.create({ attestation })`: the leaf certificate (DER). The root is the trust anchor, not sent. */
  readonly x5c: readonly Buffer[];
}

/** A fresh root and leaf. Call once per CI run; two calls share nothing. */
export function createAttestationFixture(): AttestationFixture {
  const root = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rootName = name(CI_FIXTURE_ROOT_CN);
  const rootDer = certificate({
    subject: rootName,
    issuer: rootName,
    subjectKey: root.publicKey,
    signingKey: root.privateKey,
    ca: true,
  });
  const leafDer = certificate({
    subject: name('EHR CI fixture authenticator', 'Authenticator Attestation'),
    issuer: rootName,
    subjectKey: leaf.publicKey,
    signingKey: root.privateKey,
    ca: false,
    aaguid: CI_FIXTURE_AAGUID,
  });
  // The root private key is dropped here: nothing else is ever signed by it.
  return {
    rootPem: pem(rootDer),
    aaguid: CI_FIXTURE_AAGUID,
    leafKey: createPrivateKey(leaf.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    x5c: [leafDer],
  };
}
