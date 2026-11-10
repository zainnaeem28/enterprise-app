// Pre-visit questionnaires (ARCHITECTURE 22.11, 29.2, 29.3; PRD RA-R1-06, RA-R1-21; BR-10).
//
// The patient fills in their own response on the portal: a draft is saved with `PUT /questionnaire-responses/{id}` (the client
// names the ID, so the save is idempotent: a repeat finds the row) and finished with `POST …/submit`. Submitting evaluates the
// template's red-flag rules (redflag.ts) exactly once, on the template VERSION the response was started on, stores the result on the
// row, and returns the template's emergency advice when a rule matched (AC-08). A submitted response is final: the trigger of 1701
// refuses any later change, and a merge keeps it where it is (22.16, K).
//
// The alert for the on-duty doctor is NOT inserted here (a patient session may not insert a staff alert): a red flag publishes
// `clinical.questionnaire_red_flag` in this transaction and the job `clinical.on_questionnaire_red_flag` raises it (QA-EXEC-F06,
// PRD 8.3); saving a triage raises its own alert as well (25.5). The response carries `red_flag` so the desk and the triage screen show it.
import type { Tx } from '@ehr/kernel';
import type { ChartAccess } from '../chart/access.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { badAnswerKeys, isoOrNull, patientScopeOnly } from './common.js';
import type { Row } from './common.js';
import {
  FrontdoorNotFoundError,
  FrontdoorValidationError,
  InvalidTransitionError,
  PreconditionFailedError,
  RedFlagAnswerRequiredError,
  translateDbError,
} from './errors.js';
import { isUuid } from './ids.js';
import type { CatalogPort, CheckInPort, EventPort } from './ports.js';
import { adviceOf, evaluateRedFlags } from './redflag.js';
import { QUESTIONNAIRE_RED_FLAG } from './triage.js';
import type {
  QuestionnaireForVisit,
  QuestionnaireResponseView,
  QuestionnaireTemplate,
  RequestMeta,
  SubmitResult,
} from './types.js';
import type { AuthContext } from '../../identity/index.js';

export interface QuestionnaireDeps {
  audit: ChartAuditPort;
  access: ChartAccess;
  catalog: Pick<CatalogPort, 'questionnaireTemplate'>;
  checkIns: Pick<CheckInPort, 'reservation'>;
  /** Publishes the event whose handler job raises the red-flag alert (a patient session cannot insert a staff alert). */
  events: EventPort;
}

export const toResponseView = (r: Row): QuestionnaireResponseView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  reservationId: r['reservation_id'] === null ? null : String(r['reservation_id']),
  templateKey: String(r['template_key']),
  templateVersion: Number(r['template_version']),
  answers: r['answers'] as Record<string, unknown>,
  status: r['status'] as 'in_progress' | 'submitted',
  submittedAt: isoOrNull(r['submitted_at']),
  redFlag: r['red_flag'] === true,
  version: Number(r['row_version']),
});

const TEMPLATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The question IDs a template declares, or undefined when it declares none (then any plain key is accepted). */
function declaredQuestions(t: QuestionnaireTemplate): Set<string> | undefined {
  const qs = t.schema['questions'];
  if (!Array.isArray(qs)) return undefined;
  const ids = qs
    .map((q) =>
      q !== null && typeof q === 'object' ? (q as Record<string, unknown>)['id'] : undefined,
    )
    .filter((x): x is string => typeof x === 'string');
  return ids.length === 0 ? undefined : new Set(ids);
}

export class QuestionnaireService {
  constructor(private readonly deps: QuestionnaireDeps) {}

  private async byId(tx: Tx, id: string, lock = false): Promise<Row | undefined> {
    const r = await tx.query(
      `SELECT * FROM clinical.questionnaire_response WHERE id = $1::uuid${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return r.rows[0] as Row | undefined;
  }

  /** `GET /appointments/{id}/questionnaire` (patient): the template and the patient's response for the visit. */
  async forVisit(
    tx: Tx,
    meta: RequestMeta,
    reservationId: string,
    templateKey?: string,
  ): Promise<QuestionnaireForVisit> {
    patientScopeOnly(tx);
    if (!isUuid(reservationId)) throw new FrontdoorNotFoundError();
    const res = await this.deps.checkIns.reservation(tx, reservationId.toLowerCase());
    if (res === undefined) throw new FrontdoorNotFoundError();
    if (templateKey !== undefined && !TEMPLATE_KEY.test(templateKey))
      throw new FrontdoorValidationError(['templateKey']);
    const rows = (
      await tx.query(
        `SELECT * FROM clinical.questionnaire_response
          WHERE reservation_id = $1::uuid AND patient_id = $2::uuid AND ($3::text IS NULL OR template_key = $3)
          ORDER BY created_at LIMIT 1`,
        [res.checkInId, res.patientId, templateKey ?? null],
      )
    ).rows as Row[];
    const response = rows[0] === undefined ? null : toResponseView(rows[0]);
    const key = templateKey ?? response?.templateKey;
    const template =
      key === undefined
        ? null
        : await this.deps.catalog.questionnaireTemplate(
            tx,
            key,
            response === null ? undefined : response.templateVersion,
          );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.questionnaire_response',
      resourceId: response?.id ?? null,
      patientId: res.patientId,
      locationId: res.locationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return {
      reservationId: res.checkInId,
      template:
        template === null
          ? null
          : { key: template.key, version: template.version, schema: patientView(template.schema) },
      response,
    };
  }

  /**
   * `PUT /questionnaire-responses/{id}` (patient, idempotent save). New ID: creates the draft for the visit (the patient is the
   * reservation's own patient, as the patient's RLS shows it). Known ID: `If-Match` required, the draft's answers are replaced;
   * a submitted response is `409 clinical.invalid_transition`.
   */
  async saveDraft(
    tx: Tx,
    meta: RequestMeta,
    responseId: string,
    body: Record<string, unknown>,
    expectedVersion: number | undefined,
  ): Promise<QuestionnaireResponseView> {
    const principal = patientScopeOnly(tx);
    if (!isUuid(responseId)) throw new FrontdoorNotFoundError();
    const id = responseId.toLowerCase();
    const bad = badAnswerKeys(body['answers']);
    if (bad.length > 0) throw new FrontdoorValidationError(bad);
    const answers = body['answers'] as Record<string, unknown>;
    try {
      const peek = await this.byId(tx, id);
      // Lock order (25.2): the patient root first, then the row. A merge holds the root and then moves the rows.
      if (peek !== undefined) await tx.lockPatients([String(peek['patient_id'])], 'key_share');
      const existing = peek === undefined ? undefined : await this.byId(tx, id, true);
      if (existing !== undefined) {
        const version = Number(existing['row_version']);
        if (expectedVersion === undefined || expectedVersion !== version)
          throw new PreconditionFailedError();
        if (existing['status'] !== 'in_progress') throw new InvalidTransitionError();
        await this.checkKeys(
          tx,
          String(existing['template_key']),
          Number(existing['template_version']),
          answers,
        );
        const u = await tx.query(
          `UPDATE clinical.questionnaire_response SET answers = $2::jsonb WHERE id = $1::uuid AND row_version = $3 RETURNING *`,
          [id, JSON.stringify(answers), version],
        );
        if (u.rows[0] === undefined) throw new PreconditionFailedError();
        await this.record(tx, meta, 'update', u.rows[0] as Row);
        return toResponseView(u.rows[0] as Row);
      }
      const rid = body['reservationId'];
      const key = body['templateKey'];
      const badNew: string[] = [];
      if (!isUuid(rid)) badNew.push('reservationId');
      if (typeof key !== 'string' || !TEMPLATE_KEY.test(key)) badNew.push('templateKey');
      if (badNew.length > 0) throw new FrontdoorValidationError(badNew);
      const res = await this.deps.checkIns.reservation(tx, (rid as string).toLowerCase());
      if (res === undefined) throw new FrontdoorNotFoundError();
      const tpl = await this.deps.catalog.questionnaireTemplate(tx, key as string);
      if (tpl === null) throw new FrontdoorValidationError(['templateKey']);
      const keys = declaredQuestions(tpl);
      if (keys !== undefined) {
        const unknown = Object.keys(answers).filter((k) => !keys.has(k));
        if (unknown.length > 0)
          throw new FrontdoorValidationError(unknown.map((k) => `answers/${k}`));
      }
      await tx.lockPatients([res.patientId], 'key_share');
      const ins = await tx.query(
        `INSERT INTO clinical.questionnaire_response (id, organisation_id, patient_id, reservation_id, template_key, template_version, answers, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::uuid) RETURNING *`,
        [
          id,
          res.patientId,
          res.checkInId,
          tpl.key,
          tpl.version,
          JSON.stringify(answers),
          principal,
        ],
      );
      await this.record(tx, meta, 'create', ins.rows[0] as Row);
      return toResponseView(ins.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  private async checkKeys(
    tx: Tx,
    key: string,
    version: number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const tpl = await this.deps.catalog.questionnaireTemplate(tx, key, version);
    if (tpl === null) return;
    const keys = declaredQuestions(tpl);
    if (keys === undefined) return;
    const unknown = Object.keys(answers).filter((k) => !keys.has(k));
    if (unknown.length > 0) throw new FrontdoorValidationError(unknown.map((k) => `answers/${k}`));
  }

  /** `POST /questionnaire-responses/{id}/submit` (patient, If-Match). Evaluates the rules once, stores the result, returns the advice. */
  async submit(
    tx: Tx,
    meta: RequestMeta,
    responseId: string,
    expectedVersion: number,
  ): Promise<SubmitResult> {
    patientScopeOnly(tx);
    if (!isUuid(responseId)) throw new FrontdoorNotFoundError();
    try {
      const peek = await this.byId(tx, responseId.toLowerCase());
      if (peek === undefined) throw new FrontdoorNotFoundError();
      await tx.lockPatients([String(peek['patient_id'])], 'key_share');
      const row = await this.byId(tx, responseId.toLowerCase(), true);
      if (row === undefined) throw new FrontdoorNotFoundError();
      if (Number(row['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      if (row['status'] !== 'in_progress') throw new InvalidTransitionError();
      const tpl = await this.deps.catalog.questionnaireTemplate(
        tx,
        String(row['template_key']),
        Number(row['template_version']),
      );
      const schema = tpl?.schema ?? {};
      const result = evaluateRedFlags(schema, row['answers'] as Record<string, unknown>);
      // Blank is never "no red flag": a rule question without an answer refuses the submit, unless a rule already matched
      // (the flag is the more urgent fact; the unanswered ones are reported by the form, not used to hold the flag back).
      if (!result.redFlag && result.unanswered.length > 0)
        throw new RedFlagAnswerRequiredError(result.unanswered);
      const u = await tx.query(
        `UPDATE clinical.questionnaire_response SET status = 'submitted', submitted_at = now(), red_flag = $2
          WHERE id = $1::uuid AND row_version = $3 RETURNING *`,
        [row['id'], result.redFlag, expectedVersion],
      );
      if (u.rows[0] === undefined) throw new PreconditionFailedError();
      await this.record(tx, meta, 'update', u.rows[0] as Row, {
        submitted: true,
        redFlag: result.redFlag,
      });
      // PRD 8.3, RA-R1-07 (not waivable): the red flag becomes a durable alert for the on-duty doctor. The event is published in the
      // submit's own transaction, so the flag and the job that raises its alert commit together or not at all.
      if (result.redFlag)
        await this.deps.events.publish(tx, QUESTIONNAIRE_RED_FLAG, {
          responseId: String(row['id']),
          patientId: String(row['patient_id']),
        });
      const advice = result.redFlag ? adviceOf(schema) : undefined;
      return {
        response: toResponseView(u.rows[0] as Row),
        redFlag: result.redFlag,
        ...(advice === undefined ? {} : { advice }),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `GET /patients/{id}/questionnaire-responses` (staff, `clinical.chart.read_previsit`). Newest first, bounded. */
  async listForPatient(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<QuestionnaireResponseView[]> {
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const level = await this.deps.access.level(tx, ctx, meta, patientId.toLowerCase());
    if (level === 'none') throw new FrontdoorNotFoundError();
    const r = await tx.query(
      `SELECT * FROM clinical.questionnaire_response WHERE patient_id = $1::uuid ORDER BY created_at DESC, id LIMIT 200`,
      [patientId.toLowerCase()],
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.questionnaire_response',
      patientId: patientId.toLowerCase(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { count: r.rows.length },
    });
    return (r.rows as Row[]).map(toResponseView);
  }

  /** The `PrevisitPort.questionnaireComplete` of the scheduling flow (AC-09): a submitted response exists for the visit. */
  async complete(tx: Tx, patientId: string, reservationId: string): Promise<boolean> {
    const r = await tx.query(
      `SELECT 1 FROM clinical.questionnaire_response
        WHERE patient_id = $1::uuid AND reservation_id = $2::uuid AND status = 'submitted' LIMIT 1`,
      [patientId, reservationId],
    );
    return r.rows.length > 0;
  }

  private async record(
    tx: Tx,
    meta: RequestMeta,
    action: 'create' | 'update',
    row: Row,
    change?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType: 'clinical.questionnaire_response',
      resourceId: String(row['id']),
      patientId: String(row['patient_id']),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      ...(change === undefined ? {} : { change }),
    });
  }
}

/**
 * The template as the patient's form needs it: the questions. The red-flag RULES and the emergency advice stay on the server: a
 * client cannot read the rules to shape its answers around them, and the advice is returned when (and only when) a rule matched.
 */
function patientView(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest['red_flag_rules'];
  delete rest['emergency_advice'];
  return rest;
}
