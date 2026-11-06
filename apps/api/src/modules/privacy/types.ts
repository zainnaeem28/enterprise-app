// Shapes of the privacy module (ARCHITECTURE 22.14, 29.2, 29.4).
export const REQUEST_KINDS = ['access', 'export', 'correction', 'deletion'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export type RequestStatus =
  'received' | 'identity_verified' | 'in_progress' | 'fulfilled' | 'refused' | 'blocked_d8';

export type PackageStatus = 'assembling' | 'ready' | 'failed' | 'released' | 'expired';

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type IncidentStatus = 'open' | 'investigating' | 'notified' | 'closed';

export interface RequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface PackageView {
  id: string;
  status: PackageStatus;
  /** Metadata only: parts and sizes, never content (SHARED-BOUNDARIES 6.7). */
  partCounts: Record<string, unknown>;
  sizeBytes: number | null;
  expiresAt: string | null;
  releasedAt: string | null;
  failureCode: string | null;
}

export interface RequestView {
  id: string;
  patientId: string;
  kind: RequestKind;
  channel: 'portal' | 'staff';
  status: RequestStatus;
  detail: string | null;
  verificationMethod: string | null;
  verifiedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  dueAt: string;
  /** The legal-hold check on a deletion request: documents under a hold when the system last looked. */
  legalHold: { documents: number; checkedAt: string } | null;
  package: PackageView | null;
  createdAt: string;
  version: number;
}

export interface IncidentView {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  status: IncidentStatus;
  discoveredAt: string;
  notificationDeadline: string | null;
  closedAt: string | null;
  patients: { patientId: string; auditEventIds: string[] }[];
  createdAt: string;
  version: number;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}
