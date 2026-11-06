// Pre-visit status (AC-09, F-PC-02) and the pre-visit message (33.1 `scheduling.send_previsit`).
//
// The status is three booleans: the questionnaire is complete, every consent the service requires is signed (this version or later),
// and the patient has an active insurance record. The check-in stores the status as a snapshot (`check_in.previsit_status`); the
// arrivals board and the patient's own view compute it live. The message is PHI-free (a template with a date and a link) and goes
// through `notifications.send` with a dedupe key per reservation, so a retry or a second run sends nothing twice.
import type { Tx } from '@ehr/kernel';
import { isUuid } from '../core/ids.js';
import { SchedulingValidationError } from '../core/errors.js';
import { clock, iso, record } from './common.js';
import type { FlowDeps, Row } from './common.js';
import type { FlowMeta, Previsit } from './types.js';

export type SendPrevisitOutcome = 'sent' | 'duplicate' | 'skipped' | 'gone';

export class PrevisitService {
  constructor(private readonly deps: FlowDeps) {}

  async status(
    tx: Tx,
    patientId: string,
    serviceId: string,
    reservationId: string,
  ): Promise<Previsit> {
    const required = (await this.deps.previsit?.requiredConsents?.(tx, serviceId)) ?? [];
    let consents = true;
    if (required.length > 0) {
      const st = await this.deps.records.requiredConsentStatus(tx, patientId, required);
      consents = st.every((s) => s.status === 'signed');
    }
    const ins = await tx.query(
      `SELECT 1 FROM patient.insurance_coverage WHERE patient_id = $1::uuid AND active LIMIT 1`,
      [patientId],
    );
    const questionnaire =
      this.deps.previsit?.questionnaireComplete === undefined
        ? false
        : await this.deps.previsit.questionnaireComplete(tx, patientId, reservationId);
    return { questionnaire, consents, insurance: ins.rows.length > 0 };
  }

  /**
   * `scheduling.send_previsit` (job scope `patients`, `on_merged = resolve`). Skips a reservation that is no longer `confirmed`
   * (cancelled, rescheduled, expired, no-show, already past) and one the caller's scope cannot see (`gone`: a merged patient, the job
   * then runs again under the survivor). The reservation row is read under the job's scope, so a job for the wrong patient finds nothing.
   */
  async send(tx: Tx, meta: FlowMeta, reservationId: string): Promise<SendPrevisitOutcome> {
    if (!isUuid(reservationId)) throw new SchedulingValidationError(['reservationId']);
    const r = await tx.query(
      `SELECT r.patient_id, r.location_id, o.status, lower(o.period) AS starts_at, l.time_zone
         FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
         JOIN organisation.location l ON l.id = r.location_id
        WHERE r.id = $1::uuid`,
      [reservationId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) return 'gone';
    if (
      row['status'] !== 'confirmed' ||
      new Date(iso(row['starts_at'])).getTime() <= clock(this.deps).getTime()
    )
      return 'skipped';
    const patientId = String(row['patient_id']);
    const res = await this.deps.notifications.send(tx, {
      templateKey: 'previsit_request',
      recipientRef: `patient:${patientId}`,
      variables: {
        start_at: iso(row['starts_at']),
        time_zone: String(row['time_zone']),
        portal_link: this.deps.portalUrl,
      },
      dedupeKey: `previsit:${reservationId}`,
    });
    if (res.created.length === 0) return 'duplicate';
    await record(this.deps, tx, meta, {
      action: 'create',
      resourceType: 'scheduling.previsit_message',
      resourceId: reservationId,
      patientId,
      locationId: String(row['location_id']),
    });
    return 'sent';
  }

  /**
   * When the invitation is due: the start minus the `previsit_send_offset` setting (G2, default 72 h), never in the past. `skip` when the
   * reservation is not `confirmed`, `gone` when the caller's scope cannot see it (its patient was merged: ask again as the survivor).
   */
  async dueAt(tx: Tx, reservationId: string): Promise<Date | 'skip' | 'gone'> {
    const r = await tx.query(
      `SELECT r.location_id, lower(o.period) AS starts_at, o.status
         FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE r.id = $1::uuid`,
      [reservationId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) return 'gone';
    if (row['status'] !== 'confirmed') return 'skip';
    const hours = await this.deps.organisation.setting<number>(
      tx,
      'previsit_send_offset',
      String(row['location_id']),
    );
    const due = new Date(new Date(iso(row['starts_at'])).getTime() - hours * 3_600_000);
    const now = clock(this.deps);
    return due.getTime() < now.getTime() ? now : due;
  }
}
