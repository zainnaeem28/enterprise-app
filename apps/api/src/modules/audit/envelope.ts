// The audit event envelope (SHARED-BOUNDARIES 8.1, ARCHITECTURE 22.2). The caller supplies what happened; WHO did it
// and from which organisation, realm and audience always come from the transaction's scope settings, never from the
// caller (a client-supplied actor is not authority).
import type { ScopeSettings } from '@ehr/kernel';
import { AuditEnvelopeError } from './errors.js';
import { isUuid } from './ids.js';

/** The closed action list of 22.2 (8.1 plus the six additions). */
export const AUDIT_ACTIONS = [
  'view',
  'search',
  'create',
  'update',
  'sign',
  'cosign',
  'addend',
  'export',
  'print',
  'download',
  'merge',
  'btg_open',
  'btg_review',
  'config_change',
  'role_change_request',
  'role_change_decision',
  'elevation',
  'sign_in',
  'sign_out',
  'session_revoke',
  'denied',
  'care_attach',
  'consent_exception',
  'kill_switch',
  'enrol',
  'link_person',
  'secret_write',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type DenialReason = 'forbidden' | 'not_visible';

export interface AuditEnvelope {
  /** Defaults to a new UUIDv7. A caller may supply it to correlate (the row is still one row). */
  eventId?: string;
  /** `null` for worker jobs, which use `jobId` instead. */
  requestId?: string | null;
  jobId?: string | null;
  action: Exclude<AuditAction, 'denied'>;
  /** Module-qualified, for example `clinical.note`. */
  resourceType: string;
  resourceId?: string | null;
  patientId?: string | null;
  locationId?: string | null;
  btgGrantId?: string | null;
  /** Required for BTG and export (8.1). */
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Configuration and role changes only. Secret fields must already be replaced by the secret's version ID. */
  change?: Record<string, unknown> | null;
}

/** A denial: the stored action is always `denied`; the resource is what the caller tried to reach. */
export interface DeniedEnvelope extends Omit<AuditEnvelope, 'action'> {
  denialReason: DenialReason;
}

/** The row as written, after the scope has been applied. */
export interface AuditRow {
  eventId: string;
  organisationId: string;
  requestId: string | null;
  jobId: string | null;
  actorPrincipalId: string | null;
  actorPersonId: string | null;
  realm: string;
  audience: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  patientId: string | null;
  locationId: string | null;
  btgGrantId: string | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  change: Record<string, unknown> | null;
  outcome: 'allowed' | 'denied';
  denialReason: DenialReason | null;
}

const RESOURCE_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;
const SECRET_KEY = /(secret|password|passphrase|token|private_?key|api_?key|credential)/i;
const VERSION_ID_KEY = /(version_?id)$/i;
const MAX_CHANGE_BYTES = 16 * 1024;
const MAX_DEPTH = 6;

/** A key that looks like a secret may only carry a version ID reference, never the value (BD-11). */
function secretFree(v: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => secretFree(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && !VERSION_ID_KEY.test(k)) return false;
      if (!secretFree(x, depth + 1)) return false;
    }
  }
  return true;
}

function validIp(ip: string): boolean {
  if (IPV4.test(ip)) return ip.split('.').every((o) => Number(o) <= 255);
  return ip.includes(':') && IPV6.test(ip);
}

function bad(fields: string[]): never {
  throw new AuditEnvelopeError(fields);
}

/**
 * Builds the row from the envelope and the transaction scope, or throws {@link AuditEnvelopeError} naming the fields.
 * No clinical value may be in an envelope (the audit store records that a note was viewed, not its text): the type has
 * no free-text field other than `reason`, `userAgent` and the configuration `change`.
 */
export function buildRow(
  scope: Readonly<ScopeSettings>,
  e: AuditEnvelope | DeniedEnvelope,
  eventId: string,
): AuditRow {
  const problems: string[] = [];
  if (scope.orgId === undefined) problems.push('scope.orgId');
  if (scope.realm === undefined) problems.push('scope.realm');
  const denied = 'denialReason' in e;
  if (denied && e.denialReason !== 'forbidden' && e.denialReason !== 'not_visible')
    problems.push('denialReason');
  // `denied` is not an action a caller may record as allowed; recordDenied is the only way to write it.
  if (
    !denied &&
    (e.action === ('denied' as string) || !(AUDIT_ACTIONS as readonly string[]).includes(e.action))
  )
    problems.push('action');
  if (!RESOURCE_TYPE.test(e.resourceType) || e.resourceType.length > 100)
    problems.push('resourceType');
  for (const [name, v] of [
    ['eventId', eventId],
    ['requestId', e.requestId],
    ['resourceId', e.resourceId],
    ['patientId', e.patientId],
    ['locationId', e.locationId],
    ['btgGrantId', e.btgGrantId],
  ] as const) {
    if (v !== undefined && v !== null && !isUuid(v)) problems.push(name);
  }
  const requestId = e.requestId ?? null;
  const jobId = e.jobId ?? null;
  if (requestId === null && (jobId === null || jobId.length === 0 || jobId.length > 200))
    problems.push('requestId', 'jobId');
  const reason = e.reason ?? null;
  if (reason !== null && reason.length > 500) problems.push('reason');
  if (
    !denied &&
    (e.action === 'btg_open' || e.action === 'export') &&
    (reason === null || reason.trim() === '')
  )
    problems.push('reason');
  const ip = e.ip ?? null;
  if (ip !== null && !validIp(ip)) problems.push('ip');
  const userAgent = e.userAgent ?? null;
  if (userAgent !== null && userAgent.length > 512) problems.push('userAgent');
  const change = e.change ?? null;
  if (change !== null) {
    if (typeof change !== 'object' || Array.isArray(change)) problems.push('change');
    else if (!secretFree(change, 0) || JSON.stringify(change).length > MAX_CHANGE_BYTES)
      problems.push('change');
  }
  if (problems.length > 0) bad([...new Set(problems)]);
  return {
    eventId,
    organisationId: scope.orgId as string,
    requestId,
    jobId,
    actorPrincipalId: scope.principalId ?? null,
    actorPersonId: scope.personId ?? null,
    realm: scope.realm as string,
    audience: scope.audience,
    action: denied ? 'denied' : (e as AuditEnvelope).action,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    patientId: e.patientId ?? null,
    locationId: e.locationId ?? null,
    btgGrantId: e.btgGrantId ?? null,
    reason,
    ip,
    userAgent,
    change,
    outcome: denied ? 'denied' : 'allowed',
    denialReason: denied ? e.denialReason : null,
  };
}

export const INSERT_SQL = `INSERT INTO audit.event (
  event_id, organisation_id, request_id, job_id, actor_principal_id, actor_person_id, realm, audience, action,
  resource_type, resource_id, patient_id, location_id, btg_grant_id, reason, ip, user_agent, change, outcome, denial_reason
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::inet,$17,$18::jsonb,$19,$20)`;

export function insertParams(r: AuditRow): unknown[] {
  return [
    r.eventId,
    r.organisationId,
    r.requestId,
    r.jobId,
    r.actorPrincipalId,
    r.actorPersonId,
    r.realm,
    r.audience,
    r.action,
    r.resourceType,
    r.resourceId,
    r.patientId,
    r.locationId,
    r.btgGrantId,
    r.reason,
    r.ip,
    r.userAgent,
    r.change === null ? null : JSON.stringify(r.change),
    r.outcome,
    r.denialReason,
  ];
}
