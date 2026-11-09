// Shapes the admin screens read. The generated types of these operations are opaque (`OpaqueObject`), so each reader checks
// the fields the screen shows and returns undefined for anything else; the bodies are those of the BE-24 audit routes, the BE-05
// identity admin controller and the BE-20 privacy controller. An unknown extra field is ignored, never displayed.
import { arr, num, rec, str, strOrNull } from '../preconsult/http.js';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export const parsePage =
  <T>(item: (v: unknown) => T | undefined) =>
  (data: unknown): Page<T> | undefined => {
    const d = rec(data);
    if (!Array.isArray(d['items'])) return undefined;
    const items = arr(d['items']).map(item);
    if (items.some((i) => i === undefined)) return undefined;
    return { items: items as T[], nextCursor: strOrNull(d['nextCursor']) };
  };

export interface AuditEvent {
  eventId: string;
  occurredAt: string;
  actorPersonId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientId: string | null;
  outcome: string;
  denialReason: string | null;
}
export function parseAuditEvent(v: unknown): AuditEvent | undefined {
  const o = rec(v);
  const eventId = str(o['eventId']);
  const occurredAt = str(o['occurredAt']);
  const action = str(o['action']);
  const resourceType = str(o['resourceType']);
  const outcome = str(o['outcome']);
  if (
    eventId === undefined ||
    occurredAt === undefined ||
    action === undefined ||
    resourceType === undefined ||
    outcome === undefined
  )
    return undefined;
  return {
    eventId,
    occurredAt,
    actorPersonId: strOrNull(o['actorPersonId']),
    action,
    resourceType,
    resourceId: strOrNull(o['resourceId']),
    patientId: strOrNull(o['patientId']),
    outcome,
    denialReason: strOrNull(o['denialReason']),
  };
}
export function parseAuditSearch(
  data: unknown,
): { items: AuditEvent[]; truncated: boolean } | undefined {
  const d = rec(data);
  if (!Array.isArray(d['items'])) return undefined;
  const items = arr(d['items']).map(parseAuditEvent);
  if (items.some((i) => i === undefined)) return undefined;
  return { items: items as AuditEvent[], truncated: d['truncated'] === true };
}

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';
export const EXPORT_STATUSES: readonly string[] = [
  'queued',
  'running',
  'ready',
  'failed',
  'expired',
];
export interface ExportJob {
  id: string;
  status: ExportStatus;
  rowCount: number | null;
  expiresAt: string | null;
}
export function parseExportJob(data: unknown): ExportJob | undefined {
  const o = rec(data);
  const id = str(o['id']);
  const status = str(o['status']);
  if (id === undefined || status === undefined || !EXPORT_STATUSES.includes(status))
    return undefined;
  return {
    id,
    status: status as ExportStatus,
    rowCount: num(o['rowCount']) ?? null,
    expiresAt: strOrNull(o['expiresAt']),
  };
}
export function parseDownload(data: unknown): { url: string; expiresAt: string } | undefined {
  const o = rec(data);
  const url = str(o['url']);
  const expiresAt = str(o['expiresAt']);
  return url === undefined || expiresAt === undefined ? undefined : { url, expiresAt };
}

export type ReviewStatus = 'pending' | 'justified' | 'not_justified';
export interface BtgGrant {
  id: string;
  holderPersonId: string;
  patientId: string;
  reason: string;
  openedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  reviewStatus: ReviewStatus;
  review: {
    reviewerPersonId: string;
    outcome: string;
    note: string | null;
    reviewedAt: string | null;
  } | null;
}
export function parseBtgGrant(v: unknown): BtgGrant | undefined {
  const o = rec(v);
  const id = str(o['id']);
  const holder = str(o['holderPersonId']);
  const patientId = str(o['patientId']);
  const reason = str(o['reason']);
  const openedAt = str(o['openedAt']);
  const status = str(o['reviewStatus']);
  if (
    id === undefined ||
    holder === undefined ||
    patientId === undefined ||
    reason === undefined ||
    openedAt === undefined ||
    (status !== 'pending' && status !== 'justified' && status !== 'not_justified')
  )
    return undefined;
  const r = o['review'];
  const review =
    r === null || r === undefined
      ? null
      : (() => {
          const x = rec(r);
          const reviewer = str(x['reviewerPersonId']);
          const outcome = str(x['outcome']);
          return reviewer === undefined || outcome === undefined
            ? null
            : {
                reviewerPersonId: reviewer,
                outcome,
                note: strOrNull(x['note']),
                reviewedAt: strOrNull(x['reviewedAt']),
              };
        })();
  return {
    id,
    holderPersonId: holder,
    patientId,
    reason,
    openedAt,
    expiresAt: strOrNull(o['expiresAt']),
    revokedAt: strOrNull(o['revokedAt']),
    reviewStatus: status,
    review,
  };
}

export interface Principal {
  principalId: string;
  realm: string;
  handle: string | null;
  email: string | null;
  status: string;
  displayName: string;
}
export function parsePrincipal(v: unknown): Principal | undefined {
  const o = rec(v);
  const principalId = str(o['principalId']);
  const realm = str(o['realm']);
  const status = str(o['status']);
  const displayName = str(o['displayName']);
  if (
    principalId === undefined ||
    realm === undefined ||
    status === undefined ||
    displayName === undefined
  )
    return undefined;
  return {
    principalId,
    realm,
    handle: strOrNull(o['handle']),
    email: strOrNull(o['email']),
    status,
    displayName,
  };
}

export interface Role {
  key: string;
  realm: string;
  privileged: boolean;
  locationBound: boolean;
  description: string;
  permissions: string[];
}
export function parseRole(v: unknown): Role | undefined {
  const o = rec(v);
  const key = str(o['key']);
  const realm = str(o['realm']);
  if (key === undefined || realm === undefined) return undefined;
  return {
    key,
    realm,
    privileged: o['privileged'] === true,
    locationBound: o['locationBound'] === true,
    description: str(o['description']) ?? '',
    permissions: arr(o['permissions']).filter((p): p is string => typeof p === 'string'),
  };
}

export interface RoleRef {
  roleKey: string;
  locationId?: string;
}
const parseRefs = (v: unknown): RoleRef[] =>
  arr(v).flatMap((x) => {
    const o = rec(x);
    const roleKey = str(o['roleKey']);
    if (roleKey === undefined) return [];
    const locationId = str(o['locationId']);
    return [locationId === undefined ? { roleKey } : { roleKey, locationId }];
  });
export interface RoleChange {
  id: string;
  status: string;
  subjectPrincipalId: string;
  requesterPersonId: string;
  approverPersonId: string | null;
  add: RoleRef[];
  remove: RoleRef[];
  before: RoleRef[];
  expiresAt: string;
  decidedAt: string | null;
}
export function parseRoleChange(v: unknown): RoleChange | undefined {
  const o = rec(v);
  const id = str(o['id']);
  const status = str(o['status']);
  const subject = str(o['subjectPrincipalId']);
  const requester = str(o['requesterPersonId']);
  const expiresAt = str(o['expiresAt']);
  if (
    id === undefined ||
    status === undefined ||
    subject === undefined ||
    requester === undefined ||
    expiresAt === undefined
  )
    return undefined;
  return {
    id,
    status,
    subjectPrincipalId: subject,
    requesterPersonId: requester,
    approverPersonId: strOrNull(o['approverPersonId']),
    add: parseRefs(o['add']),
    remove: parseRefs(o['remove']),
    before: parseRefs(o['before']),
    expiresAt,
    decidedAt: strOrNull(o['decidedAt']),
  };
}

export type PrivacyStatus =
  'received' | 'identity_verified' | 'in_progress' | 'fulfilled' | 'refused' | 'blocked_d8';
export const PRIVACY_STATUSES: readonly string[] = [
  'received',
  'identity_verified',
  'in_progress',
  'fulfilled',
  'refused',
  'blocked_d8',
];
export interface PrivacyRequest {
  id: string;
  patientId: string;
  kind: string;
  channel: string;
  status: PrivacyStatus;
  detail: string | null;
  verificationMethod: string | null;
  verifiedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  dueAt: string;
  legalHold: { documents: number; checkedAt: string } | null;
  package: {
    status: string;
    sizeBytes: number | null;
    expiresAt: string | null;
    failureCode: string | null;
  } | null;
  createdAt: string;
  version: number | undefined;
}
export function parsePrivacyRequest(v: unknown): PrivacyRequest | undefined {
  const o = rec(v);
  const id = str(o['id']);
  const patientId = str(o['patientId']);
  const kind = str(o['kind']);
  const status = str(o['status']);
  const dueAt = str(o['dueAt']);
  const createdAt = str(o['createdAt']);
  if (
    id === undefined ||
    patientId === undefined ||
    kind === undefined ||
    status === undefined ||
    !PRIVACY_STATUSES.includes(status) ||
    dueAt === undefined ||
    createdAt === undefined
  )
    return undefined;
  const hold = rec(o['legalHold']);
  const pkg = rec(o['package']);
  return {
    id,
    patientId,
    kind,
    channel: str(o['channel']) ?? 'portal',
    status: status as PrivacyStatus,
    detail: strOrNull(o['detail']),
    verificationMethod: strOrNull(o['verificationMethod']),
    verifiedAt: strOrNull(o['verifiedAt']),
    decidedAt: strOrNull(o['decidedAt']),
    decisionReason: strOrNull(o['decisionReason']),
    dueAt,
    legalHold:
      num(hold['documents']) !== undefined && str(hold['checkedAt']) !== undefined
        ? {
            documents: num(hold['documents']) as number,
            checkedAt: str(hold['checkedAt']) as string,
          }
        : null,
    package:
      str(pkg['status']) === undefined
        ? null
        : {
            status: str(pkg['status']) as string,
            sizeBytes: num(pkg['sizeBytes']) ?? null,
            expiresAt: strOrNull(pkg['expiresAt']),
            failureCode: strOrNull(pkg['failureCode']),
          },
    createdAt,
    version: num(o['version']),
  };
}
