// Triage and the red-flag alert (ARCHITECTURE 22.11, 25.5; PRD RA-R1-06, RA-R1-07; BR-10, AC-08).
//
// `POST /check-ins/{id}/triage` saves an assessment and, in the SAME transaction, raises the red-flag alert when a rule of the
// questionnaire template matches an answer or the nurse marks the red flag. The alert row, its `created` event, the triage row, the
// queue entry's category and the `clinical.red_flag_raised` event all commit together or not at all. The nurse who raises it is not
// one of its targets (the on-duty doctor is), and still sees it (the alert policy lets its creator read it, 22.13).
//
// What this file does NOT decide: which answers are red flags (the template's rules, D-12a), when an unacknowledged alert escalates
// (the staff_alert_setting row, PM-confirm-1, D-12a: no value is assumed here), what the emergency advice says (the template).
//
// Concurrency: the assessments of one check-in form a chain (a re-triage supersedes the head). The chain length is the route's ETag.
// A transaction-scoped advisory lock keyed by the check-in serialises two nurses; the second finds a longer chain than its
// If-Match and gets 412 (TC-PC-06). The unique indexes of 1700 back this up if a lock is ever skipped.
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { PreconditionFailedError } from '../chart/errors.js';
import { PreconditionRequiredError } from '../../patient/index.js';
import { badAnswerKeys, iso, isoOrNull, staffPrincipal, strOrNull } from './common.js';
import type { Row } from './common.js';
import {
  FrontdoorNotFoundError,
  FrontdoorValidationError,
  RedFlagAnswerRequiredError,
  RedFlagNoRecipientError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { AlertPort, CatalogPort, CheckInPort, DutyPort, EventPort } from './ports.js';
import { adviceOf, evaluateRedFlags } from './redflag.js';
import { TRIAGE_CATEGORIES } from './types.js';
import type { RequestMeta, TriageCategory, TriageResult, TriageView } from './types.js';

export const RED_FLAG_PERMISSION = 'clinical.alert.red_flag.receive';
export const RED_FLAG_RAISED = 'clinical.red_flag_raised';
export const ROSTER_GAP = 'clinical.roster_gap';

export interface TriageDeps {
  audit: ChartAuditPort;
  checkIns: CheckInPort;
  duty: DutyPort;
  alerts: AlertPort;
  catalog: Pick<CatalogPort, 'questionnaireTemplate'>;
  events: EventPort;
  now?: () => Date;
}

export const toTriageView = (r: Row): TriageView => ({
  id: String(r['id']),
  checkInId: String(r['check_in_id']),
  patientId: String(r['patient_id']),
  category: r['category'] as TriageCategory,
  symptoms: (r['symptoms'] as Record<string, unknown> | null) ?? null,
  notes: strOrNull(r['notes']),
  redFlag: r['red_flag'] === true,
  alertId: strOrNull(r['alert_id']),
  byPrincipalId: String(r['by_principal_id']),
  assessedAt: iso(r['assessed_at']),
  supersedesId: strOrNull(r['supersedes_id']),
});

const TEMPLATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class TriageService {
  private readonly now: () => Date;

  constructor(private readonly deps: TriageDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** The chain of a check-in, oldest first. */
  private async chain(tx: Tx, checkInId: string): Promise<TriageView[]> {
    const r = await tx.query(
      `SELECT * FROM clinical.triage_assessment WHERE check_in_id = $1::uuid ORDER BY assessed_at, id`,
      [checkInId],
    );
    const rows = (r.rows as Row[]).map(toTriageView);
    // Order the chain by its links, not by the clock (two rows can share a timestamp): the head is the one nobody supersedes.
    const byPrev = new Map(rows.map((x) => [x.supersedesId, x]));
    const out: TriageView[] = [];
    let cur = byPrev.get(null);
    while (cur !== undefined && out.length <= rows.length) {
      out.push(cur);
      cur = byPrev.get(cur.id);
    }
    return out;
  }

  /** `GET /check-ins/{id}/triage`: the current assessment (the end of the chain) and the chain length (the ETag). */
  async current(
    tx: Tx,
    meta: RequestMeta,
    checkInId: string,
  ): Promise<{ triage: TriageView | null; chainLength: number }> {
    if (!isUuid(checkInId)) throw new FrontdoorNotFoundError();
    const ci = await this.deps.checkIns.get(tx, checkInId.toLowerCase());
    if (ci === undefined) throw new FrontdoorNotFoundError();
    const chain = await this.chain(tx, ci.checkInId);
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.triage_assessment',
      patientId: ci.patientId,
      locationId: ci.locationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { triage: chain[chain.length - 1] ?? null, chainLength: chain.length };
  }

  async record(
    tx: Tx,
    meta: RequestMeta,
    checkInId: string,
    body: Record<string, unknown>,
    expectedChainLength: number | undefined,
  ): Promise<TriageResult> {
    const principal = staffPrincipal(tx);
    if (!isUuid(checkInId)) throw new FrontdoorNotFoundError();
    const bad: string[] = [];
    if (
      typeof body['category'] !== 'string' ||
      !(TRIAGE_CATEGORIES as readonly string[]).includes(body['category'])
    )
      bad.push('category');
    const marked = body['redFlag'];
    if (marked !== undefined && typeof marked !== 'boolean') bad.push('redFlag');
    const notes = body['notes'];
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 5000))
      bad.push('notes');
    let symptoms: Record<string, unknown> | null = null;
    if (body['symptoms'] !== undefined && body['symptoms'] !== null) {
      const b = badAnswerKeys(body['symptoms']).map((k) => k.replace(/^answers/, 'symptoms'));
      if (b.length > 0) bad.push(...b);
      else symptoms = body['symptoms'] as Record<string, unknown>;
    }
    const templateKey = body['templateKey'];
    if (
      templateKey !== undefined &&
      (typeof templateKey !== 'string' || !TEMPLATE_KEY.test(templateKey))
    )
      bad.push('templateKey');
    if (bad.length > 0) throw new FrontdoorValidationError(bad);
    const category = body['category'] as TriageCategory;

    const ci = await this.deps.checkIns.get(tx, checkInId.toLowerCase());
    if (ci === undefined) throw new FrontdoorNotFoundError();
    try {
      // The queue entry's category first: the scheduling service takes the patient lock (key_share, once per transaction, 25.2) as its
      // first act, so nothing here may lock the patient again. A later refusal rolls the category back with everything else.
      await this.deps.checkIns.setTriageCategory(tx, meta, ci.checkInId, category);
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `triage:${ci.checkInId}`,
      ]);
      const chain = await this.chain(tx, ci.checkInId);
      if (chain.length > 0 && expectedChainLength === undefined)
        throw new PreconditionRequiredError();
      if (expectedChainLength !== undefined && expectedChainLength !== chain.length)
        throw new PreconditionFailedError();
      const head = chain[chain.length - 1];

      // The template and the answers the rules read: the visit's response (if any) with the nurse's own answers laid over it.
      const response = (
        await tx.query(
          `SELECT template_key, template_version, answers FROM clinical.questionnaire_response
            WHERE reservation_id = $1::uuid AND patient_id = $2::uuid AND status = 'submitted'
              AND ($3::text IS NULL OR template_key = $3) ORDER BY submitted_at DESC LIMIT 1`,
          [ci.checkInId, ci.patientId, (templateKey as string | undefined) ?? null],
        )
      ).rows[0] as Row | undefined;
      const key =
        (templateKey as string | undefined) ?? (response?.['template_key'] as string | undefined);
      const tpl =
        key === undefined
          ? null
          : await this.deps.catalog.questionnaireTemplate(
              tx,
              key,
              response === undefined || response['template_key'] !== key
                ? undefined
                : Number(response['template_version']),
            );
      if (key !== undefined && tpl === null) throw new FrontdoorValidationError(['templateKey']);
      const answers = {
        ...((response?.['answers'] as Record<string, unknown> | undefined) ?? {}),
        ...(symptoms ?? {}),
      };
      const result = tpl === null ? undefined : evaluateRedFlags(tpl.schema, answers);
      if (
        result !== undefined &&
        !result.redFlag &&
        marked !== true &&
        result.unanswered.length > 0
      )
        throw new RedFlagAnswerRequiredError(result.unanswered);
      const redFlag = marked === true || result?.redFlag === true;

      const id = uuidv7();
      let alertId: string | null = null;
      let escalatesAt: Date | null = null;
      if (redFlag) {
        let targets = await this.deps.duty.onDuty(tx, ci.locationId, 'on_duty_doctor', this.now());
        if (targets.length === 0) {
          // No doctor rostered: every holder of the receive permission at the location, and the roster gap is reported (25.5).
          targets = await this.deps.duty.permissionHoldersAt(
            tx,
            RED_FLAG_PERMISSION,
            ci.locationId,
          );
          await this.deps.events.publish(tx, ROSTER_GAP, {
            locationId: ci.locationId,
            duty: 'on_duty_doctor',
            triageId: id,
          });
        }
        // The nurse who raises the flag is not its target (38.2 item 16), unless nobody else can receive it: a doctor who triages
        // alone is then their own recipient, and the flag is not lost.
        const others = targets.filter((p) => p !== principal);
        if (others.length > 0) targets = others;
        if (targets.length === 0) throw new RedFlagNoRecipientError();
        const raised = await this.deps.alerts.raise(tx, {
          type: 'red_flag',
          severity: 'critical',
          targets: { kind: 'principal', principalIds: targets },
          resourceType: 'triage_assessment',
          resourceId: id,
          patientId: ci.patientId,
          locationId: ci.locationId,
        });
        alertId = raised.alertId;
        escalatesAt = raised.escalatesAt;
      }

      const ins = await tx.query(
        `INSERT INTO clinical.triage_assessment (id, organisation_id, check_in_id, patient_id, location_id, category, symptoms, notes,
                                                 red_flag, alert_id, by_principal_id, supersedes_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7, $8, $9, $10::uuid, $11, $10::uuid)
         RETURNING *`,
        [
          id,
          ci.checkInId,
          ci.patientId,
          ci.locationId,
          category,
          symptoms === null ? null : JSON.stringify(symptoms),
          typeof notes === 'string' ? notes : null,
          redFlag,
          alertId,
          principal,
          head?.id ?? null,
        ],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'clinical.triage_assessment',
        resourceId: id,
        patientId: ci.patientId,
        locationId: ci.locationId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { category, redFlag, alertId, retriage: head !== undefined },
      });
      if (redFlag)
        await this.deps.events.publish(tx, RED_FLAG_RAISED, {
          alertId,
          patientId: ci.patientId,
          locationId: ci.locationId,
          triageId: id,
        });
      const advice = redFlag && tpl !== null ? adviceOf(tpl.schema) : undefined;
      return {
        triage: toTriageView(ins.rows[0] as Row),
        category,
        redFlag,
        alertId,
        escalatesAt: isoOrNull(escalatesAt),
        ...(advice === undefined ? {} : { advice }),
        chainLength: chain.length + 1,
      };
    } catch (e) {
      const c = e as { code?: unknown; constraint?: unknown };
      if (
        c?.code === '23505' &&
        (c.constraint === 'triage_first_per_check_in_uq' || c.constraint === 'triage_supersedes_uq')
      )
        throw new PreconditionFailedError();
      translateDbError(e);
    }
  }

  /**
   * `clinical.on_alert_unacknowledged` (25.5): an unacknowledged red flag re-targets to the on-call doctor. The worker handler opens
   * a patients-scope transaction and calls this. The TIMING is not here: the escalation job fires at the alert's `escalate_at`, which
   * comes from `staff_alert_setting` (no default for red_flag: PM-confirm-1, D-12a). Returns the principals added (empty: nobody on
   * call, or the alert is not a red flag).
   */
  async retargetUnacknowledged(tx: Tx, alertId: string): Promise<string[]> {
    if (!isUuid(alertId)) throw new FrontdoorValidationError(['alertId']);
    const a = (
      await tx.query(
        `SELECT type, location_id FROM notifications.staff_alert WHERE id = $1::uuid`,
        [alertId],
      )
    ).rows[0] as Row | undefined;
    if (a === undefined || a['type'] !== 'red_flag' || a['location_id'] === null) return [];
    const onCall = await this.deps.duty.onDuty(
      tx,
      String(a['location_id']),
      'on_call_doctor',
      this.now(),
    );
    if (onCall.length === 0) return [];
    return this.deps.alerts.addTargets(tx, alertId, { kind: 'principal', principalIds: onCall });
  }
}
