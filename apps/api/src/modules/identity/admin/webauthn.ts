// The WebAuthn ceremony library behind a small port (ARCHITECTURE 26.1, SEC-01 B2-1). Everything that parses CBOR, COSE or
// ASN.1 or checks a signature is done by the exact-pinned `@simplewebauthn/server`; nothing of that is written here. This file
// fixes the ceremony PARAMETERS (B2-2) and the enrolment policy (B2-3), and turns every library failure into `ok: false`
// so that no library message ever reaches a response.
//
// Counter: the library is always given a stored counter of 0 so that it never throws on a regression by itself. The
// counter rule is ours, atomic and in the database (22.4, B2-4): the caller compares the presented counter with the stored
// one and decides between "regression, revoke" and "lost a race, refuse".
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  SettingsService,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeAttestationObject } from '@simplewebauthn/server/helpers';
import { b64urlDecode, b64urlEncode } from './b64.js';

/** ES256 only: every FIDO2 security key supports it. */
const COSE_ES256 = -7;
export const CHALLENGE_BYTES = 32;
export const CHALLENGE_SECONDS = 120;

export interface CeremonyParams {
  /** The exact `staff.` host (B2-2): never a parent domain. */
  rpId: string;
  rpName: string;
  /** Exact origins (scheme, host, port). */
  expectedOrigins: readonly string[];
}

export interface Assertion {
  rawId: Buffer;
  /** The parsed browser response, ready for the library. */
  response: AuthenticationResponseJSON;
}

export type AssertionResult = { ok: true; presentedCounter: number } | { ok: false };

export interface EnrolledKey {
  aaguid: string;
  credentialId: Buffer;
  publicKey: Buffer;
  transports: string[];
  /** BE flag (backup eligible) and BS flag (backed up): both refused (B2-3). */
  backupEligible: boolean;
  backedUp: boolean;
  userVerified: boolean;
  fmt: string;
  /** The statement carried a certificate chain (x5c). */
  hasChain: boolean;
}
export type AttestationResult = { ok: true; key: EnrolledKey } | { ok: false };

export interface WebAuthnPort {
  authenticationOptions(p: {
    challenge: Buffer;
    allow: readonly { id: Buffer; transports: readonly string[] }[];
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  registrationOptions(p: {
    challenge: Buffer;
    handle: string;
    userId: Buffer;
    exclude: readonly { id: Buffer; transports: readonly string[] }[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyAssertion(p: {
    assertion: Assertion;
    challenge: Buffer;
    publicKey: Buffer;
  }): Promise<AssertionResult>;
  verifyAttestation(p: { response: unknown; challenge: Buffer }): Promise<AttestationResult>;
}

/**
 * `chain`: production. Attestation must carry a certificate chain that validates to one of the roots Cybersecurity keeps
 * (OPEN-3); an empty root list is a configuration error, so the process fails closed at start-up.
 * `self_for_tests`: accepts packed self-attestation. Test fixtures only; never constructed by the application entry point.
 */
export type AttestationPolicy =
  { mode: 'chain'; rootCertificatesPem: readonly string[] } | { mode: 'self_for_tests' };

const ROOT_FORMATS = ['packed', 'tpm', 'android-key', 'fido-u2f', 'apple'] as const;

export class SimpleWebAuthnPort implements WebAuthnPort {
  constructor(
    private readonly params: CeremonyParams,
    private readonly policy: AttestationPolicy,
  ) {
    if (policy.mode === 'chain') {
      if (policy.rootCertificatesPem.length === 0)
        throw new Error(
          'admin WebAuthn: attestation mode "chain" needs at least one root certificate',
        );
      for (const identifier of ROOT_FORMATS)
        SettingsService.setRootCertificates({
          identifier,
          certificates: [...policy.rootCertificatesPem],
        });
    }
    if (params.expectedOrigins.length === 0) throw new Error('admin WebAuthn: no expected origin');
    for (const o of params.expectedOrigins)
      if (
        !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o) &&
        !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
      )
        throw new Error('admin WebAuthn: an expected origin must be an exact origin');
  }

  authenticationOptions(p: {
    challenge: Buffer;
    allow: readonly { id: Buffer; transports: readonly string[] }[];
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.params.rpId,
      challenge: new Uint8Array(p.challenge),
      timeout: CHALLENGE_SECONDS * 1000,
      userVerification: 'required',
      allowCredentials: p.allow.map((c) => ({
        id: b64urlEncode(c.id),
        transports: [...c.transports],
      })),
    });
  }

  registrationOptions(p: {
    challenge: Buffer;
    handle: string;
    userId: Buffer;
    exclude: readonly { id: Buffer; transports: readonly string[] }[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.params.rpName,
      rpID: this.params.rpId,
      userName: p.handle,
      userID: new Uint8Array(p.userId),
      challenge: new Uint8Array(p.challenge),
      timeout: CHALLENGE_SECONDS * 1000,
      attestationType: 'direct',
      supportedAlgorithmIDs: [COSE_ES256],
      excludeCredentials: p.exclude.map((c) => ({
        id: b64urlEncode(c.id),
        transports: [...c.transports],
      })),
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
        authenticatorAttachment: 'cross-platform',
      },
    });
  }

  async verifyAssertion(p: {
    assertion: Assertion;
    challenge: Buffer;
    publicKey: Buffer;
  }): Promise<AssertionResult> {
    try {
      const r = await verifyAuthenticationResponse({
        response: p.assertion.response,
        expectedChallenge: b64urlEncode(p.challenge),
        expectedOrigin: [...this.params.expectedOrigins],
        expectedRPID: this.params.rpId,
        requireUserVerification: true,
        credential: {
          id: b64urlEncode(p.assertion.rawId),
          publicKey: new Uint8Array(p.publicKey),
          counter: 0, // the counter rule is ours (see the header)
        },
      });
      if (!r.verified || !r.authenticationInfo.userVerified) return { ok: false };
      return { ok: true, presentedCounter: r.authenticationInfo.newCounter };
    } catch {
      return { ok: false };
    }
  }

  async verifyAttestation(p: { response: unknown; challenge: Buffer }): Promise<AttestationResult> {
    try {
      const response = p.response as RegistrationResponseJSON;
      const r = await verifyRegistrationResponse({
        response,
        expectedChallenge: b64urlEncode(p.challenge),
        expectedOrigin: [...this.params.expectedOrigins],
        expectedRPID: this.params.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [COSE_ES256],
      });
      if (!r.verified) return { ok: false };
      const info = r.registrationInfo;
      const att = decodeAttestationObject(info.attestationObject);
      const hasChain = (att.get('attStmt').get('x5c')?.length ?? 0) > 0;
      const fmt = att.get('fmt');
      if (this.policy.mode === 'chain' && (fmt === 'none' || !hasChain)) return { ok: false };
      if (this.policy.mode === 'self_for_tests' && fmt === 'none') return { ok: false };
      const credentialId = b64urlDecode(info.credential.id, 1023);
      if (credentialId === undefined) return { ok: false };
      return {
        ok: true,
        key: {
          aaguid: info.aaguid,
          credentialId,
          publicKey: Buffer.from(info.credential.publicKey),
          transports: (info.credential.transports ?? []).map(String),
          backupEligible: info.credentialDeviceType === 'multiDevice',
          backedUp: info.credentialBackedUp,
          userVerified: info.userVerified,
          fmt,
          hasChain,
        },
      };
    } catch {
      return { ok: false };
    }
  }
}

/** Shape-checks the browser's assertion before it reaches the library; returns undefined for anything else. */
export function parseAssertion(v: unknown): Assertion | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const rawId = b64urlDecode(o['rawId'], 1023);
  if (rawId === undefined || o['id'] !== b64urlEncode(rawId)) return undefined;
  if (o['type'] !== 'public-key') return undefined;
  const r = o['response'];
  if (typeof r !== 'object' || r === null) return undefined;
  const rr = r as Record<string, unknown>;
  for (const k of ['clientDataJSON', 'authenticatorData', 'signature'])
    if (b64urlDecode(rr[k], 8192) === undefined) return undefined;
  if (
    rr['userHandle'] !== undefined &&
    rr['userHandle'] !== null &&
    typeof rr['userHandle'] !== 'string'
  )
    return undefined;
  return {
    rawId,
    response: {
      id: o['id'],
      rawId: o['rawId'],
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: rr['clientDataJSON'],
        authenticatorData: rr['authenticatorData'],
        signature: rr['signature'],
      },
    } as AuthenticationResponseJSON,
  };
}

/** Shape-checks the browser's attestation response. */
export function parseAttestation(v: unknown): RegistrationResponseJSON | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const rawId = b64urlDecode(o['rawId'], 1023);
  if (rawId === undefined || o['id'] !== b64urlEncode(rawId) || o['type'] !== 'public-key')
    return undefined;
  const r = o['response'];
  if (typeof r !== 'object' || r === null) return undefined;
  const rr = r as Record<string, unknown>;
  if (b64urlDecode(rr['clientDataJSON'], 8192) === undefined) return undefined;
  if (b64urlDecode(rr['attestationObject'], 65536) === undefined) return undefined;
  const transports = rr['transports'];
  if (
    transports !== undefined &&
    (!Array.isArray(transports) ||
      transports.length > 8 ||
      !transports.every((t) => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)))
  )
    return undefined;
  return {
    id: o['id'],
    rawId: o['rawId'],
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: rr['clientDataJSON'],
      attestationObject: rr['attestationObject'],
      ...(transports === undefined ? {} : { transports }),
    },
  } as RegistrationResponseJSON;
}
