import type { Queue, Tx } from '@ehr/kernel';
import type { AuditEnvelope, AuditService } from '../../audit/index.js';
import type { NotificationService } from '../../notifications/index.js';
import type { OrganisationService } from '../../organisation/index.js';
import type { PatientRecordsService } from '../../patient/index.js';
import type { AvailabilityPort } from '../core/types.js';
import type { FlowMeta, PrevisitPort, QrKeyProvider } from './types.js';

export type Row = Record<string, unknown>;

export interface FlowDeps {
  audit: AuditService;
  organisation: Pick<
    OrganisationService,
    | 'bookingPolicy'
    | 'setting'
    | 'settingOrNull'
    | 'consentTemplatesRequired'
    | 'consentTemplateWording'
  >;
  /** The booking core's availability port (BE-12): the waitlist hold goes through `scheduling.hold`, which asks it. */
  availability: AvailabilityPort;
  notifications: Pick<NotificationService, 'send' | 'cancel'>;
  records: Pick<
    PatientRecordsService,
    'requiredConsentStatus' | 'requestConsent' | 'withdrawStalePendingConsent' | 'getPreferences'
  >;
  queue?: Queue;
  qrKey: QrKeyProvider;
  previsit?: PrevisitPort;
  /** The patient portal's sign-in URL for messages (must be on the notification module's allowed hosts). */
  portalUrl: string;
  now?: () => Date;
}

export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);

/** Audit through the caller's transaction: a request names its request ID, a job its job ID. */
export function record(
  deps: FlowDeps,
  tx: Tx,
  meta: FlowMeta,
  e: Omit<AuditEnvelope, 'requestId' | 'jobId' | 'ip' | 'userAgent'>,
): Promise<string> {
  // A job names itself (the audit row of a worker action carries the job, not a request); a request names its request ID.
  return deps.audit.record(tx, {
    ...e,
    requestId: meta.jobId === undefined || meta.jobId === null ? meta.requestId : null,
    ...(meta.jobId === undefined || meta.jobId === null ? {} : { jobId: meta.jobId }),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
}

export const clock = (deps: FlowDeps): Date => deps.now?.() ?? new Date();

/** The location's local calendar date (YYYY-MM-DD) at `at`, in the location's time zone, and the zone itself. */
export async function localDate(
  tx: Tx,
  locationId: string,
  at: Date,
): Promise<{ date: string; timeZone: string } | undefined> {
  const r = await tx.query(
    `SELECT ($2::timestamptz AT TIME ZONE l.time_zone)::date::text AS d, l.time_zone
       FROM organisation.location l WHERE l.id = $1::uuid`,
    [locationId, at.toISOString()],
  );
  const row = r.rows[0] as Row | undefined;
  return row === undefined
    ? undefined
    : { date: String(row['d']), timeZone: String(row['time_zone']) };
}

export const graceMinutes = (
  policy: { noShowGraceMin: number; noShowGraceVideoMin: number },
  mode: string,
): number => (mode === 'video' ? policy.noShowGraceVideoMin : policy.noShowGraceMin);
