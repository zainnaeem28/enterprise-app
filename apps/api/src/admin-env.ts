// Admin realm configuration of the API process (INT04-F01, SEC02-F01). Fail closed: there is NO default for the attestation roots,
// the approved AAGUIDs or the decoy key, and nothing here accepts a test value; a missing or malformed variable stops the start with
// its NAME. The admin WebAuthn port in `chain` mode is the only mode this loader can produce (`self_for_tests` is reachable only by
// injecting a port in a test).
import { ConfigError } from '@ehr/kernel';
import type { IdentityEnv } from './identity-env.js';

export interface AdminEnv {
  readonly rpName: string;
  /** PEM certificates of the FIDO roots Cybersecurity approved (B2-3). */
  readonly attestationRootsPem: readonly string[];
  /** Lower-case AAGUIDs Cybersecurity approved (B2-3, OPEN-3). */
  readonly allowedAaguids: readonly string[];
  readonly decoyKey: string;
}

const AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_AAGUID = '00000000-0000-0000-0000-000000000000';
const PEM = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;

export function loadAdminEnv(
  env: Readonly<Record<string, string | undefined>>,
  identity: Pick<IdentityEnv, 'rateKey' | 'csrfKey'>,
): AdminEnv {
  const problems: string[] = [];

  const rootsRaw = env['EHR_ADMIN_ATTESTATION_ROOTS_PEM'] ?? '';
  const roots = rootsRaw.match(PEM) ?? [];
  if (rootsRaw.trim() === '') problems.push('EHR_ADMIN_ATTESTATION_ROOTS_PEM is required');
  else if (roots.length === 0)
    problems.push('EHR_ADMIN_ATTESTATION_ROOTS_PEM must hold at least one PEM certificate');
  else if (rootsRaw.replace(PEM, '').trim() !== '')
    problems.push('EHR_ADMIN_ATTESTATION_ROOTS_PEM must hold only PEM certificates');

  const aaguidsRaw = (env['EHR_ADMIN_ALLOWED_AAGUIDS'] ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a !== '');
  if (aaguidsRaw.length === 0) problems.push('EHR_ADMIN_ALLOWED_AAGUIDS is required');
  // The all-zero AAGUID is what an authenticator reports when it hides its model: it can never identify an approved one.
  if (aaguidsRaw.some((a) => !AAGUID.test(a) || a === NIL_AAGUID))
    problems.push('EHR_ADMIN_ALLOWED_AAGUIDS must be a list of non-zero AAGUIDs');

  const decoyKey = env['EHR_ADMIN_DECOY_KEY'] ?? '';
  if (decoyKey === '') problems.push('EHR_ADMIN_DECOY_KEY is required');
  else if (decoyKey.length < 32)
    problems.push('EHR_ADMIN_DECOY_KEY must be at least 32 characters');
  else if (decoyKey === identity.rateKey || decoyKey === identity.csrfKey)
    problems.push('EHR_ADMIN_DECOY_KEY must differ from EHR_RATE_KEY and EHR_CSRF_KEY');

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    rpName: env['EHR_ADMIN_RP_NAME']?.trim() || 'EHR admin',
    attestationRootsPem: roots,
    allowedAaguids: aaguidsRaw,
    decoyKey,
  };
}
