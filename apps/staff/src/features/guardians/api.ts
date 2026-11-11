import type { components } from '@ehr/contracts';
import { arr, guard, newKey, rec, str } from '../preconsult/http.js';
import type { Api, Outcome } from '../preconsult/http.js';

export const SCOPES = ['appointments', 'messages', 'documents'] as const;
export type Scope = (typeof SCOPES)[number];
export type GuardianRelationship = 'parent' | 'guardian';
export type GrantStatus = 'invited' | 'requested' | 'verified' | 'active' | 'revoked' | 'expired';
const STATUSES: readonly string[] = [
  'invited',
  'requested',
  'verified',
  'active',
  'revoked',
  'expired',
];
const RELATIONSHIPS: readonly string[] = ['parent', 'guardian', 'carer', 'other'];

export interface Grant {
  id: string;
  relationship: string;
  status: GrantStatus;
  guardian: boolean;
  scopes: Scope[];
  effectiveScopes: Scope[];
  inviteeHint: string | undefined;
  validUntil: string | undefined;
}

const scopesOf = (v: unknown): Scope[] =>
  arr(v).filter((x): x is Scope => SCOPES.includes(x as Scope));

export function parseGrant(v: unknown): Grant | undefined {
  const o = rec(v);
  const id = str(o['id']);
  const status = str(o['status']);
  const relationship = str(o['relationship']);
  if (
    id === undefined ||
    status === undefined ||
    !STATUSES.includes(status) ||
    relationship === undefined ||
    !RELATIONSHIPS.includes(relationship)
  )
    return undefined;
  return {
    id,
    relationship,
    status: status as GrantStatus,
    guardian: o['guardian'] === true,
    scopes: scopesOf(o['scopes']),
    effectiveScopes: scopesOf(o['effectiveScopes']),
    inviteeHint: str(o['inviteeHint']),
    validUntil: str(o['validUntil']),
  };
}

export type GuardiansApi = ReturnType<typeof createGuardiansApi>;

/** The staff side of ruling C item 3: the proxies and invitations of a patient, a guardian link and a revoke. */
export function createGuardiansApi(api: Api) {
  const header = api.header;
  return {
    grants: (patientId: string): Promise<Outcome<Grant[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/proxy-grants', {
            params: { header, path: { patientId } },
          }),
        (d) => {
          const out = arr(rec(d)['items']).map(parseGrant);
          return out.every((x) => x !== undefined) ? (out as Grant[]) : undefined;
        },
      ),

    /** The guardian is told by e-mail and accepts with a code; nothing is shared until they do. */
    link: (
      patientId: string,
      body: components['schemas']['GuardianLinkRequest'],
      key: string,
    ): Promise<Outcome<Grant>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/guardian-links', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body,
          }),
        (d) => parseGrant(d),
      ),

    revoke: (patientId: string, grantId: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/proxies/{grantId}/revoke', {
            params: { header, path: { patientId, grantId } },
          }),
        () => true as const,
      ),
  };
}

export { newKey };
