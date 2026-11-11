// What the worker's telehealth jobs ask of the module (apps/worker/src/jobs/telehealth reaches it through `telehealthPort`). The worker
// cannot import this package; the jobs decide the scope (a patients-scope transaction for the one patient for everything that writes, an
// organisation-scope one for the sweep's list), this service does the work inside it. Vendor calls are the jobs', outside any transaction.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import { SessionNotFoundError, TelehealthValidationError, translateDbError } from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { CLOSE_AFTER_MINUTES, STALE_AFTER_HOURS } from './rules.js';
import type { TelehealthMeta } from './types.js';

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export interface TelehealthJobDeps {
  audit: AuditService;
}

export type EnsureOutcome =
  | {
      outcome: 'created' | 'exists';
      sessionId: string;
      startsAt: string;
      endsAt: string;
      hasMeeting: boolean;
    }
  | { outcome: 'skipped' }
  | { outcome: 'gone' };

export interface StaleSession {
  sessionId: string;
  patientId: string;
}

export interface EndedStale {
  status: 'ended' | 'failed' | 'already';
  vendor: string | null;
  meetingId: string | null;
}

export type CloseOutcome =
  | { outcome: 'none' | 'not_due' }
  | { outcome: 'close'; sessionId: string; vendor: string; meetingId: string };

/** `scheduling.slot_occupancy.status` values after which the visit cannot happen (or has happened). */
const OVER = [
  'completed',
  'cancelled_patient',
  'cancelled_clinic',
  'rescheduled',
  'no_show',
  'expired',
];

export class TelehealthJobService {
  constructor(private readonly deps: TelehealthJobDeps) {}

  private patientOf(tx: Tx): string {
    const ids = tx.scope.jobPatientIds ?? [];
    if (tx.scope.jobScope !== 'patients' || ids.length !== 1) throw new SessionNotFoundError();
    return (ids[0] as string).toLowerCase();
  }

  /**
   * The session row of a confirmed video reservation, made if absent (idempotent: the reservation is the key). Runs under the one
   * patient the booking belongs to; a reservation re-pointed by a merge is not that patient's any more (`gone`: the job asks for the
   * survivor). An in-person visit, or one that is no longer live, is `skipped`.
   */
  async ensureSession(tx: Tx, meta: TelehealthMeta, reservationId: string): Promise<EnsureOutcome> {
    if (!isUuid(reservationId)) throw new TelehealthValidationError(['reservationId']);
    const patientId = this.patientOf(tx);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = (
        await tx.query(
          `SELECT r.id, r.patient_id, r.clinician_principal_id, r.mode, o.status, lower(o.period) AS starts_at, upper(o.period) AS ends_at
             FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
            WHERE r.id = $1::uuid AND r.patient_id = $2::uuid`,
          [reservationId.toLowerCase(), patientId],
        )
      ).rows[0] as Row | undefined;
      if (r === undefined) return { outcome: 'gone' };
      if (r['mode'] !== 'video') return { outcome: 'skipped' };
      const existing = (
        await tx.query(
          `SELECT id, vendor_meeting_id FROM telehealth.video_session WHERE reservation_id = $1::uuid`,
          [reservationId.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      if (existing !== undefined)
        return {
          outcome: 'exists',
          sessionId: String(existing['id']),
          startsAt: iso(r['starts_at']),
          endsAt: iso(r['ends_at']),
          hasMeeting: existing['vendor_meeting_id'] !== null,
        };
      if (!['confirmed', 'checked_in', 'in_consultation'].includes(String(r['status'])))
        return { outcome: 'skipped' };
      const id = uuidv7();
      await tx.query(
        `INSERT INTO telehealth.video_session (id, organisation_id, reservation_id, patient_id, clinician_principal_id)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid)
         ON CONFLICT (reservation_id) DO NOTHING`,
        [id, reservationId.toLowerCase(), patientId, r['clinician_principal_id']],
      );
      await this.deps.audit.record(tx, {
        requestId: null,
        jobId: meta.jobId ?? null,
        action: 'create',
        resourceType: 'telehealth.video_session',
        resourceId: id,
        patientId,
        ip: null,
        userAgent: null,
      });
      return {
        outcome: 'created',
        sessionId: id,
        startsAt: iso(r['starts_at']),
        endsAt: iso(r['ends_at']),
        hasMeeting: false,
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** Records the vendor's room once (`NULL -> value`; the database refuses a second). True when this call set it or it was already set. */
  async recordMeeting(
    tx: Tx,
    meta: TelehealthMeta,
    sessionId: string,
    vendor: string,
    meetingId: string,
  ): Promise<boolean> {
    if (!isUuid(sessionId)) throw new TelehealthValidationError(['sessionId']);
    const patientId = this.patientOf(tx);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const r = await tx.query(
        `UPDATE telehealth.video_session SET vendor = $2, vendor_meeting_id = $3
          WHERE id = $1::uuid AND vendor_meeting_id IS NULL AND status IN ('scheduled', 'open')`,
        [sessionId.toLowerCase(), vendor, meetingId],
      );
      if ((r.rowCount ?? 0) === 0) {
        const cur = await tx.query(
          `SELECT 1 FROM telehealth.video_session WHERE id = $1::uuid AND vendor_meeting_id IS NOT NULL`,
          [sessionId.toLowerCase()],
        );
        return cur.rows.length > 0;
      }
      await this.deps.audit.record(tx, {
        requestId: null,
        jobId: meta.jobId ?? null,
        action: 'update',
        resourceType: 'telehealth.video_session',
        resourceId: sessionId.toLowerCase(),
        patientId,
        change: { meeting: 'created' },
        ip: null,
        userAgent: null,
      });
      return true;
    } catch (e) {
      translateDbError(e);
    }
  }

  /** Organisation scope: live sessions whose slot ended more than STALE_AFTER_HOURS ago (33.1 `telehealth.end_stale`). */
  async staleSessions(tx: Tx, limit = 200): Promise<StaleSession[]> {
    const r = await tx.query(
      `SELECT v.id, v.patient_id FROM telehealth.video_session v
         JOIN scheduling.slot_occupancy o ON o.id = v.reservation_id
        WHERE v.status IN ('scheduled', 'open') AND upper(o.period) + make_interval(hours => $2::int) <= now()
        ORDER BY upper(o.period), v.id LIMIT $1::int`,
      [limit, STALE_AFTER_HOURS],
    );
    return (r.rows as Row[]).map((x) => ({
      sessionId: String(x['id']),
      patientId: String(x['patient_id']),
    }));
  }

  /**
   * Ends one stale session under its patient's scope: live tokens are revoked first (the database refuses to end a session that holds
   * one), then the session ends (`failed` when no room was ever made). Returns the room to close at the vendor once this commits.
   */
  async endStale(tx: Tx, meta: TelehealthMeta, sessionId: string): Promise<EndedStale> {
    if (!isUuid(sessionId)) throw new TelehealthValidationError(['sessionId']);
    const patientId = this.patientOf(tx);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const s = (
        await tx.query(
          `SELECT v.status, v.vendor, v.vendor_meeting_id FROM telehealth.video_session v
             JOIN scheduling.slot_occupancy o ON o.id = v.reservation_id
            WHERE v.id = $1::uuid AND v.patient_id = $2::uuid
              AND upper(o.period) + make_interval(hours => $3::int) <= now() FOR UPDATE OF v`,
          [sessionId.toLowerCase(), patientId, STALE_AFTER_HOURS],
        )
      ).rows[0] as Row | undefined;
      if (s === undefined || (s['status'] !== 'scheduled' && s['status'] !== 'open'))
        return { status: 'already', vendor: null, meetingId: null };
      await tx.query(
        `UPDATE telehealth.participant SET left_at = now()
          WHERE session_id = $1::uuid AND joined_at IS NOT NULL AND left_at IS NULL`,
        [sessionId.toLowerCase()],
      );
      await tx.query(
        `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'session_ended'
          WHERE session_id = $1::uuid AND status = 'issued'`,
        [sessionId.toLowerCase()],
      );
      const to = s['vendor_meeting_id'] === null ? 'failed' : 'ended';
      await tx.query(`UPDATE telehealth.video_session SET status = $2 WHERE id = $1::uuid`, [
        sessionId.toLowerCase(),
        to,
      ]);
      await this.deps.audit.record(tx, {
        requestId: null,
        jobId: meta.jobId ?? null,
        action: 'update',
        resourceType: 'telehealth.video_session',
        resourceId: sessionId.toLowerCase(),
        patientId,
        change: { status: to, stale: true },
        ip: null,
        userAgent: null,
      });
      return {
        status: to,
        vendor: s['vendor'] === null ? null : String(s['vendor']),
        meetingId: s['vendor_meeting_id'] === null ? null : String(s['vendor_meeting_id']),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `telehealth.close_meeting`, step 1 (patients scope): is the vendor room of this reservation's session due to be closed? It is when the
   * visit is over (completed, cancelled, rescheduled, no-show, expired), the session already ended, or the join window (the slot's end
   * plus CLOSE_AFTER_MINUTES) has closed. A session still live is ended here, join tokens revoked first (the database refuses otherwise).
   * No session, or no room ever made, is `none`. The vendor is told by the job afterwards; repeating this changes nothing.
   */
  async meetingToClose(tx: Tx, meta: TelehealthMeta, reservationId: string): Promise<CloseOutcome> {
    if (!isUuid(reservationId)) throw new TelehealthValidationError(['reservationId']);
    const patientId = this.patientOf(tx);
    try {
      await tx.lockPatients([patientId], 'key_share');
      const s = (
        await tx.query(
          `SELECT v.id, v.status, v.vendor, v.vendor_meeting_id, o.status AS occ_status,
                  upper(o.period) + make_interval(mins => $3::int) <= now() AS window_closed
             FROM telehealth.video_session v JOIN scheduling.slot_occupancy o ON o.id = v.reservation_id
            WHERE v.reservation_id = $1::uuid AND v.patient_id = $2::uuid FOR UPDATE OF v`,
          [reservationId.toLowerCase(), patientId, CLOSE_AFTER_MINUTES],
        )
      ).rows[0] as Row | undefined;
      if (s === undefined || s['vendor_meeting_id'] === null || s['vendor'] === null)
        return { outcome: 'none' };
      const live = s['status'] === 'scheduled' || s['status'] === 'open';
      const due = !live || OVER.includes(String(s['occ_status'])) || s['window_closed'] === true;
      if (!due) return { outcome: 'not_due' };
      const sessionId = String(s['id']);
      if (live) {
        await tx.query(
          `UPDATE telehealth.participant SET left_at = now()
            WHERE session_id = $1::uuid AND joined_at IS NOT NULL AND left_at IS NULL`,
          [sessionId],
        );
        await tx.query(
          `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'session_ended'
            WHERE session_id = $1::uuid AND status = 'issued'`,
          [sessionId],
        );
        await tx.query(`UPDATE telehealth.video_session SET status = 'ended' WHERE id = $1::uuid`, [
          sessionId,
        ]);
        await this.deps.audit.record(tx, {
          requestId: null,
          jobId: meta.jobId ?? null,
          action: 'update',
          resourceType: 'telehealth.video_session',
          resourceId: sessionId,
          patientId,
          change: { status: 'ended', closeMeeting: true },
          ip: null,
          userAgent: null,
        });
      }
      return {
        outcome: 'close',
        sessionId,
        vendor: String(s['vendor']),
        meetingId: String(s['vendor_meeting_id']),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `telehealth.close_meeting`, step 3: the vendor confirmed the room is closed (or gone); the visit audit records it. */
  async recordMeetingClosed(tx: Tx, meta: TelehealthMeta, sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) throw new TelehealthValidationError(['sessionId']);
    const patientId = this.patientOf(tx);
    try {
      await this.deps.audit.record(tx, {
        requestId: null,
        jobId: meta.jobId ?? null,
        action: 'update',
        resourceType: 'telehealth.video_session',
        resourceId: sessionId.toLowerCase(),
        patientId,
        change: { meeting: 'closed' },
        ip: null,
        userAgent: null,
      });
    } catch (e) {
      translateDbError(e);
    }
  }
}
