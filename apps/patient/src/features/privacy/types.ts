// Shapes of the privacy request views (apps/api privacy `RequestView`, `PackageView`). The contract types them as opaque objects.
import { asRecord, str } from '../profile/lib/core.js';

export type Kind = 'access' | 'export' | 'correction' | 'deletion';
export type Status =
  'received' | 'identity_verified' | 'in_progress' | 'fulfilled' | 'refused' | 'blocked_d8';
export type PackageStatus = 'assembling' | 'ready' | 'failed' | 'released' | 'expired';

export interface PrivacyRequest {
  id: string;
  kind: Kind;
  status: Status;
  createdAt: string;
  dueAt: string;
  decisionReason: string | undefined;
  packageStatus: PackageStatus | undefined;
  packageExpiresAt: string | undefined;
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
