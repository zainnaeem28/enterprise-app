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
import type {
  FlowMeta,
  Previsit,
  PrevisitConsentsOpened,
  PrevisitRequiredConsent,
  PrevisitView,
} from './types.js';

interface ConsentItem {
  key: string;
  version: number;
  status: PrevisitRequiredConsent['status'];
  /** The current (non-stale) pending row, only when `status = 'pending'`. */
  pendingId: string | null;
  language: string;
  /** Pending rows whose own (key, version, language) is no longer published (D1 rule 4). */
  stalePendingIds: string[];
}

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
   * The required consents of the service with the patient's status for each (HEAAA-296 D1 rules 1, 3, 4). One item per key at the max
   * published version across languages, sorted by key. Three indexed reads, none per item: `consentTemplatesRequired`, one
   * `requiredConsentStatus`, and (for the language choice) the preferences. Wording is read separately, only for the rows returned.
   */
  private async items(tx: Tx, patientId: string, serviceId: string): Promise<ConsentItem[]> {
    const rows = await this.deps.organisation.consentTemplatesRequired(tx, serviceId);
    const byKey = new Map<string, { version: number; languages: Set<string> }>();
    for (const t of rows) {
      const cur = byKey.get(t.key);
      if (cur === undefined || t.version > cur.version)
        byKey.set(t.key, { version: t.version, languages: new Set([t.language]) });
      else if (t.version === cur.version) cur.languages.add(t.language);
    }
    const keys = [...byKey.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (keys.length === 0) return [];
    const required = keys.map((key) => ({ key, version: byKey.get(key)?.version ?? 0 }));
    const statuses = await this.deps.records.requiredConsentStatus(tx, patientId, required);
    const preferred = (await this.deps.records.getPreferences(tx, patientId))?.language ?? null;
    return required.map((t, i) => {
      const published = byKey.get(t.key)?.languages ?? new Set<string>();
      const st = statuses[i];
      const pending = st?.pending ?? [];
      const current = pending.filter(
        (p) => p.version === t.version && p.language !== null && published.has(p.language),
      );
      const stale = pending.filter((p) => !current.includes(p));
      const cur = current[0];
      let status: ConsentItem['status'] = st?.status ?? 'missing';
      // Every pending row is stale: nothing to sign, and the POST treats `missing` and `outdated` alike (rule 4).
      if (status === 'pending' && cur === undefined) status = 'missing';
      return {
        key: t.key,
        version: t.version,
        status,
        pendingId: status === 'pending' ? (cur?.id ?? null) : null,
        language: this.chooseLanguage(
          status === 'pending' ? (cur?.language ?? null) : null,
          preferred,
          published,
        ),
        stalePendingIds: stale.map((p) => p.id),
      };
    });
  }

  /** D1 rule 3: the pending row's language, else the patient's, else `en`, else the lowest value published at the version. */
  private chooseLanguage(
    pendingLanguage: string | null,
    preferred: string | null,
    published: ReadonlySet<string>,
  ): string {
    if (pendingLanguage !== null && published.has(pendingLanguage)) return pendingLanguage;
    if (preferred !== null && published.has(preferred)) return preferred;
    if (published.has('en')) return 'en';
    return [...published].sort()[0] ?? 'en';
  }

  /**
   * The patient's view of the pre-visit (HEAAA-296 D1): the three flags, `canOpenConsents` and the required consents with their wording
   * and status. Read-only. A proxy never gets here (the guard answers 404, E14). `consents` is exactly "every listed consent is signed".
   */
  async view(
    tx: Tx,
    r: { reservationId: string; patientId: string; serviceId: string; occupancy: string },
  ): Promise<PrevisitView> {
    const base = await this.status(tx, r.patientId, r.serviceId, r.reservationId);
    const items = await this.items(tx, r.patientId, r.serviceId);
    const wording = await this.deps.organisation.consentTemplateWording(
      tx,
      items.map((i) => ({ key: i.key, version: i.version, language: i.language })),
    );
    const requiredConsents: PrevisitRequiredConsent[] = items.map((i) => {
      const w = wording.find(
        (x) => x.key === i.key && x.version === i.version && x.language === i.language,
      );
      return {
        id: i.pendingId,
        templateKey: i.key,
        templateVersion: i.version,
        language: i.language,
        title: w?.title ?? null,
        text: w?.text ?? null,
        status: i.status,
      };
    });
    return {
      reservationId: r.reservationId,
      ...base,
      consents: requiredConsents.every((c) => c.status === 'signed'),
      canOpenConsents: r.occupancy === 'confirmed' || r.occupancy === 'checked_in',
      requiredConsents,
    };
  }

  /**
   * `POST /appointments/{reservationId}/previsit/consents` (HEAAA-296 D2), one transaction: withdraw every stale pending row, then open a
   * pending consent at the required version for each item that is `missing` or `outdated`. Signed and current pending rows are
   * untouched. `requestConsent` is idempotent through `consent_one_pending_uq`; the withdraw is conditional on `status = 'pending'`.
   * Returns the compact body (ids, versions, languages, statuses; no wording) read after the writes.
   */
  async openConsents(
    tx: Tx,
    meta: FlowMeta,
    r: { reservationId: string; patientId: string; serviceId: string },
  ): Promise<PrevisitConsentsOpened> {
    for (const item of await this.items(tx, r.patientId, r.serviceId)) {
      for (const id of item.stalePendingIds)
        await this.deps.records.withdrawStalePendingConsent(tx, meta, id);
      if (item.status === 'missing' || item.status === 'outdated')
        await this.deps.records.requestConsent(
          tx,
          meta,
          r.patientId,
          item.key,
          item.version,
          item.language,
        );
    }
    return {
      reservationId: r.reservationId,
      requiredConsents: (await this.items(tx, r.patientId, r.serviceId)).map((i) => ({
        id: i.pendingId,
        templateKey: i.key,
        templateVersion: i.version,
        language: i.language,
        status: i.status,
      })),
    };
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
