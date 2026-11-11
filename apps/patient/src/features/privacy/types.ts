// Shapes of the privacy request views (apps/api privacy `RequestView`, `PackageView`). The contract types them as opaque objects.
import { asRecord, str } from '../profile/lib/core.js';

export type Kind = 'access' | 'export' | 'correction' | 'deletion';
export type Status =
  'received' | 'identity_verified' | 'in_progress' | 'fulfilled' | 'refused' | 'blocked_d8';
export type PackageStatus = 'assembling' | 'ready' | 'failed' | 'released' | 'expired';

export interface ClassCount {
  class: string;
  count: number;
}

/** The post-deletion statement (PrivacyDeletionStatement): class names, counts, dates and reasons as codes; never PHI. */
export interface DeletionStatement {
  executedAt: string;
  deleted: ClassCount[];
  kept: ClassCount[];
  keptReason: string;
  keptUntil: string;
  heldDocuments: number;
  keptByHold: ClassCount[];
  auditYears: number | undefined;
  documentationYears: number | undefined;
  purgeState: string | undefined;
  purgeDeferredReason: string | undefined;
}

export interface PrivacyRequest {
  id: string;
  kind: Kind;
  status: Status;
  createdAt: string;
  dueAt: string;
  decisionReason: string | undefined;
  packageStatus: PackageStatus | undefined;
  packageExpiresAt: string | undefined;
  /** Set once a deletion has been carried out. */
  deletion: DeletionStatement | undefined;
}

const counts = (v: unknown): ClassCount[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const o = asRecord(x);
        const c = str(o['class']);
        return c !== undefined && typeof o['count'] === 'number'
          ? [{ class: c, count: o['count'] }]
          : [];
      })
    : [];

function parseDeletion(v: unknown): DeletionStatement | undefined {
  const d = asRecord(v);
  const st = asRecord(d['statement']);
  const executedAt = str(st['executedAt']);
  const keptUntil = str(st['keptUntil']) ?? str(d['retainedUntil']);
  if (executedAt === undefined || keptUntil === undefined) return undefined;
  const years = (k: string) => {
    const y = asRecord(st[k])['years'];
    return typeof y === 'number' ? y : undefined;
  };
  return {
    executedAt,
    deleted: counts(st['deleted']),
    kept: counts(st['kept']),
    keptReason: str(st['keptReason']) ?? 'medical_record_retention',
    keptUntil,
    heldDocuments: Number(asRecord(st['legalHold'])['documents'] ?? d['heldDocuments'] ?? 0) || 0,
    keptByHold: counts(st['keptByHold']),
    auditYears: years('auditTrail'),
    documentationYears: years('documentation'),
    purgeState: str(d['purgeState']),
    purgeDeferredReason: str(d['purgeDeferredReason']),
  };
}

const KINDS: readonly string[] = ['access', 'export', 'correction', 'deletion'];
const STATUSES: readonly string[] = [
  'received',
  'identity_verified',
  'in_progress',
  'fulfilled',
  'refused',
  'blocked_d8',
];
const PACKAGES: readonly string[] = ['assembling', 'ready', 'failed', 'released', 'expired'];

export function parseRequest(v: unknown): PrivacyRequest | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const kind = str(o['kind']);
  const status = str(o['status']);
  const createdAt = str(o['createdAt']);
  if (
    id === undefined ||
    createdAt === undefined ||
    kind === undefined ||
    !KINDS.includes(kind) ||
    status === undefined ||
    !STATUSES.includes(status)
  )
    return undefined;
  const pkg = asRecord(o['package']);
  const ps = str(pkg['status']);
  return {
    id,
    kind: kind as Kind,
    status: status as Status,
    createdAt,
    dueAt: str(o['dueAt']) ?? '',
    decisionReason: str(o['decisionReason']),
    packageStatus: ps !== undefined && PACKAGES.includes(ps) ? (ps as PackageStatus) : undefined,
    packageExpiresAt: str(pkg['expiresAt']),
    deletion: parseDeletion(o['deletion']),
  };
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

export function parseDownload(v: unknown): DownloadUrl | undefined {
  const o = asRecord(v);
  const url = str(o['url']);
  const expiresAt = str(o['expiresAt']);
  return url === undefined || expiresAt === undefined ? undefined : { url, expiresAt };
}
