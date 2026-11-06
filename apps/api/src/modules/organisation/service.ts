import type { Tx } from '@ehr/kernel';
import {
  NeutralNameRequiredError,
  OrganisationValidationError,
  SettingNotConfiguredError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { SETTING_CATALOGUE } from './settings-catalogue.js';
import { assertMatchesSchema } from './settings.js';

type Row = Record<string, unknown>;

export interface DirectoryLocation {
  id: string;
  name: string;
  kind: 'clinic' | 'virtual';
  timeZone: string;
  address: unknown;
  stateCode: string;
  geo: unknown;
  phone: string | null;
}
export interface DirectoryService {
  id: string;
  patientDisplayName: string;
  durationMin: number;
  mode: 'in_person' | 'video' | 'either';
}
export interface ServiceRecord extends DirectoryService {
  internalName: string;
  bufferMin: number;
  priceCents: number | null;
  currency: string | null;
  feeCents: number | null;
  conditionRevealing: boolean;
  active: boolean;
}
export interface BookingPolicy {
  serviceId: string;
  locationId: string | null;
  leadTimeMin: number;
  cutoffHours: number;
  /** `block` is the default (D-3). `fee` is stored only: this module has no code that charges anything. */
  lateChange: 'block' | 'fee';
  maxFuturePerPatient: number;
  waitlistEnabled: boolean;
  overbookCapPerSession: number;
  holdMinutes: number;
  noShowGraceMin: number;
  noShowGraceVideoMin: number;
  /** false when no policy row exists and the values come from the settings. */
  configured: boolean;
}
export type LicensingResult = 'allowed' | 'refused_not_licensed' | 'refused_not_operating';

export interface NewService {
  internalName: string;
  /** Required (and must differ from `internalName`) when `conditionRevealing`. Defaults to `internalName` otherwise. */
  patientDisplayName?: string;
  durationMin: number;
  bufferMin: number;
  mode: 'in_person' | 'video' | 'either';
  priceCents?: number;
  currency?: string;
  feeCents?: number;
  conditionRevealing?: boolean;
}
export interface NewBookingPolicy {
  serviceId: string;
  locationId?: string | null;
  leadTimeMin?: number;
  cutoffHours?: number;
  lateChange?: 'block' | 'fee';
  maxFuturePerPatient?: number;
  waitlistEnabled?: boolean;
  overbookCapPerSession?: number;
  holdMinutes?: number;
  noShowGraceMin?: number;
}

const str = (v: unknown): string => v as string;
const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toService(r: Row): ServiceRecord {
  return {
    id: str(r.id),
    internalName: str(r.internal_name),
    patientDisplayName: str(r.patient_display_name),
    durationMin: num(r.duration_min),
    bufferMin: num(r.buffer_min),
    mode: r.mode as ServiceRecord['mode'],
    priceCents: optNum(r.price_cents),
    currency: (r.currency as string | null) ?? null,
    feeCents: optNum(r.fee_cents),
    conditionRevealing: r.condition_revealing === true,
    active: r.active === true,
  };
}

const toDirectoryLocation = (r: Row): DirectoryLocation => ({
  id: str(r.id),
  name: str(r.name),
  kind: r.kind as DirectoryLocation['kind'],
  timeZone: str(r.time_zone),
  address: r.address ?? null,
  stateCode: str(r.state_code),
  geo: r.geo ?? null,
  phone: (r.phone as string | null) ?? null,
});

/**
 * The `organisation` module interface (ARCHITECTURE 24). Every method runs in the caller's scoped transaction, so RLS decides
 * what is visible. The directory methods read only the C0 views of 22.5.1. No method here charges, or can charge, anything.
 */
export class OrganisationService {
  // --- settings (31.4) ---------------------------------------------------------------------------------------------

  /** The stored value for `key`: the row for `locationId` when there is one, else the organisation default. Fails closed. */
  async setting<T = unknown>(tx: Tx, key: string, locationId?: string | null): Promise<T> {
    const v = await this.settingOrNull<T>(tx, key, locationId);
    if (v === undefined) throw new SettingNotConfiguredError(key);
    return v;
  }

  async settingOrNull<T = unknown>(
    tx: Tx,
    key: string,
    locationId?: string | null,
  ): Promise<T | undefined> {
    if (locationId !== undefined && locationId !== null && !isUuid(locationId))
      throw new OrganisationValidationError(['locationId']);
    const r = await tx.query(
      `SELECT value FROM kernel.setting
        WHERE key = $1 AND (location_id IS NULL OR location_id = $2::uuid)
        ORDER BY location_id NULLS LAST LIMIT 1`,
      [key, locationId ?? null],
    );
    const row = r.rows[0];
    return row === undefined ? undefined : (row.value as T);
  }

  /**
   * Seeds the catalogue (settings-catalogue.ts) into kernel.setting for the scope's organisation. Worker job, audience
   * `system`, job scope `org`. Existing rows are never overwritten (an admin's change survives a re-seed); entries with no
   * proposal are skipped. Returns the keys inserted.
   */
  async applySettingDefaults(tx: Tx, jobId?: string): Promise<string[]> {
    const s = tx.scope;
    if (s.audience !== 'system' || s.orgId === undefined)
      throw new OrganisationValidationError(['scope']);
    const inserted: string[] = [];
    for (const entry of SETTING_CATALOGUE) {
      if (entry.value === null) continue;
      assertMatchesSchema(entry.schema, entry.value, entry.key);
      const r = await tx.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, location_id, pre_auth, created_by_job)
         VALUES ($1, $2, $3, $4::jsonb, $5, NULL, $6, $7)
         ON CONFLICT ON CONSTRAINT setting_org_key_location_uq DO NOTHING
         RETURNING key`,
        [
          uuidv7(),
          s.orgId,
          entry.key,
          JSON.stringify(entry.value),
          entry.schema,
          entry.preAuth,
          jobId ?? null,
        ],
      );
      if (r.rows.length > 0) inserted.push(entry.key);
    }
    return inserted;
  }

  /**
   * Admin change of one catalogued setting (organisation.setting.manage; the guard checks the permission). The value must
   * match the key's schema. Keys readable before sign-in (`pre_auth`) are set by reference data only (policy), so a
   * change of one here is refused by the database.
   */
  async setSetting(tx: Tx, key: string, value: unknown, locationId?: string | null): Promise<void> {
    const entry = SETTING_CATALOGUE.find((x) => x.key === key);
    if (entry === undefined) throw new OrganisationValidationError(['key']);
    assertMatchesSchema(entry.schema, value);
    if (locationId !== undefined && locationId !== null && !isUuid(locationId))
      throw new OrganisationValidationError(['locationId']);
    const updated = await tx.query(
      `UPDATE kernel.setting SET value = $3::jsonb
        WHERE key = $1 AND location_id IS NOT DISTINCT FROM $2::uuid RETURNING id`,
      [key, locationId ?? null, JSON.stringify(value)],
    );
    if (updated.rows.length > 0) return;
    await tx.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, location_id, pre_auth, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, false, $7)`,
      [
        uuidv7(),
        tx.scope.orgId,
        key,
        JSON.stringify(value),
        entry.schema,
        locationId ?? null,
        tx.scope.principalId ?? null,
      ],
    );
  }

  // --- directory (22.5.1: the C0 views only) -----------------------------------------------------------------------

  async directoryLocations(tx: Tx): Promise<DirectoryLocation[]> {
    const r = await tx.query(
      `SELECT id, name, kind, time_zone, address, state_code, geo, phone FROM organisation.public_location ORDER BY name, id`,
    );
    return r.rows.map(toDirectoryLocation);
  }

  async directoryServices(
    tx: Tx,
    filter: { locationId?: string } = {},
  ): Promise<DirectoryService[]> {
    if (filter.locationId !== undefined && !isUuid(filter.locationId))
      throw new OrganisationValidationError(['locationId']);
    const r = await tx.query(
      `SELECT s.id, s.patient_display_name, s.duration_min, s.mode
         FROM organisation.public_service s
        WHERE $1::uuid IS NULL OR EXISTS (
          SELECT 1 FROM organisation.public_service_location sl WHERE sl.service_id = s.id AND sl.location_id = $1::uuid)
        ORDER BY s.patient_display_name, s.id`,
      [filter.locationId ?? null],
    );
    return r.rows.map((x) => ({
      id: str(x.id),
      patientDisplayName: str(x.patient_display_name),
      durationMin: num(x.duration_min),
      mode: x.mode as DirectoryService['mode'],
    }));
  }

  /** Principal IDs of the clinicians eligible for the service. The route intersects them with the identity and scheduling views (22.5.1). */
  async directoryServiceClinicians(tx: Tx, serviceId: string): Promise<string[]> {
    if (!isUuid(serviceId)) throw new OrganisationValidationError(['serviceId']);
    const r = await tx.query(
      `SELECT clinician_principal_id FROM organisation.public_service_clinician WHERE service_id = $1 ORDER BY clinician_principal_id`,
      [serviceId],
    );
    return r.rows.map((x) => str(x.clinician_principal_id));
  }

  // --- configuration reads (staff and system) ---------------------------------------------------------------------

  async location(tx: Tx, id: string): Promise<(DirectoryLocation & { active: boolean }) | null> {
    if (!isUuid(id)) throw new OrganisationValidationError(['id']);
    const r = await tx.query(
      `SELECT id, name, kind, time_zone, address, state_code, geo, phone, active FROM organisation.location WHERE id = $1`,
      [id],
    );
    const x = r.rows[0];
    return x === undefined ? null : { ...toDirectoryLocation(x), active: x.active === true };
  }

  async services(tx: Tx, filter: { active?: boolean } = {}): Promise<ServiceRecord[]> {
    const r = await tx.query(
      `SELECT * FROM organisation.service WHERE $1::boolean IS NULL OR active = $1::boolean ORDER BY internal_name, id`,
      [filter.active ?? null],
    );
    return r.rows.map(toService);
  }

  /**
   * Creates a service. BR-23: a condition-revealing service must carry a patient-visible name that differs from its internal
   * one (422 `organisation.neutral_name_required`); the database enforces the same rule. Price and fee are stored only.
   */
  async createService(tx: Tx, input: NewService): Promise<string> {
    const revealing = input.conditionRevealing === true;
    const internal = input.internalName.trim();
    const display = (input.patientDisplayName ?? '').trim();
    if (internal.length === 0 || internal.length > 200)
      throw new OrganisationValidationError(['internalName']);
    if (revealing && (display.length === 0 || display.toLowerCase() === internal.toLowerCase()))
      throw new NeutralNameRequiredError();
    const id = uuidv7();
    await tx.query(
      `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min,
                                         mode, price_cents, currency, fee_cents, condition_revealing, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        tx.scope.orgId,
        internal,
        display.length > 0 ? display : internal,
        input.durationMin,
        input.bufferMin,
        input.mode,
        input.priceCents ?? null,
        input.currency ?? null,
        input.feeCents ?? null,
        revealing,
        tx.scope.principalId ?? null,
      ],
    );
    return id;
  }

  // --- booking policy (D-3: block-only by default) ----------------------------------------------------------------

  /**
   * The effective policy for (service, location): the location's own row, else the service-wide row, else a block-only
   * policy built from the settings. Overrides left null on a row are read from the settings (hold, grace).
   */
  async bookingPolicy(
    tx: Tx,
    serviceId: string,
    locationId?: string | null,
  ): Promise<BookingPolicy> {
    if (!isUuid(serviceId)) throw new OrganisationValidationError(['serviceId']);
    if (locationId !== undefined && locationId !== null && !isUuid(locationId))
      throw new OrganisationValidationError(['locationId']);
    const r = await tx.query(
      `SELECT * FROM organisation.booking_policy
        WHERE service_id = $1 AND (location_id IS NULL OR location_id = $2::uuid)
        ORDER BY location_id NULLS LAST LIMIT 1`,
      [serviceId, locationId ?? null],
    );
    const row = r.rows[0];
    const grace = await this.setting<{ default: number; video: number }>(
      tx,
      'no_show_grace_min',
      locationId,
    );
    const hold =
      row?.hold_minutes != null
        ? num(row.hold_minutes)
        : await this.setting<number>(tx, 'hold_minutes', locationId);
    return {
      serviceId,
      locationId:
        row === undefined ? (locationId ?? null) : ((row.location_id as string | null) ?? null),
      leadTimeMin: row === undefined ? 0 : num(row.lead_time_min),
      cutoffHours:
        row === undefined
          ? await this.setting<number>(tx, 'cutoff_hours', locationId)
          : num(row.cutoff_hours),
      lateChange: row === undefined ? 'block' : (row.late_change as BookingPolicy['lateChange']),
      maxFuturePerPatient:
        row === undefined
          ? await this.setting<number>(tx, 'max_future_per_patient', locationId)
          : num(row.max_future_per_patient),
      waitlistEnabled: row === undefined ? false : row.waitlist_enabled === true,
      overbookCapPerSession: row === undefined ? 0 : num(row.overbook_cap_per_session),
      holdMinutes: hold,
      noShowGraceMin: row?.no_show_grace_min != null ? num(row.no_show_grace_min) : grace.default,
      noShowGraceVideoMin: grace.video,
      configured: row !== undefined,
    };
  }

  /** Stores a policy. `lateChange` defaults to `block`; `fee` is accepted and stored, never charged. Cut-off and cap come from the settings when omitted. */
  async createBookingPolicy(tx: Tx, input: NewBookingPolicy): Promise<string> {
    if (!isUuid(input.serviceId)) throw new OrganisationValidationError(['serviceId']);
    if (input.locationId !== undefined && input.locationId !== null && !isUuid(input.locationId))
      throw new OrganisationValidationError(['locationId']);
    const cutoff =
      input.cutoffHours ?? (await this.setting<number>(tx, 'cutoff_hours', input.locationId));
    const cap =
      input.maxFuturePerPatient ??
      (await this.setting<number>(tx, 'max_future_per_patient', input.locationId));
    const id = uuidv7();
    await tx.query(
      `INSERT INTO organisation.booking_policy (id, organisation_id, service_id, location_id, lead_time_min, cutoff_hours,
                                                late_change, max_future_per_patient, waitlist_enabled,
                                                overbook_cap_per_session, hold_minutes, no_show_grace_min, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        tx.scope.orgId,
        input.serviceId,
        input.locationId ?? null,
        input.leadTimeMin ?? 0,
        cutoff,
        input.lateChange ?? 'block',
        cap,
        input.waitlistEnabled ?? false,
        input.overbookCapPerSession ?? 0,
        input.holdMinutes ?? null,
        input.noShowGraceMin ?? null,
        tx.scope.principalId ?? null,
      ],
    );
    return id;
  }

  // --- templates --------------------------------------------------------------------------------------------------

  /** Keys of the consent templates the service requires, each with its latest published version per language. */
  async consentTemplatesRequired(
    tx: Tx,
    serviceId: string,
  ): Promise<{ key: string; version: number; language: string; bodyDocumentId: string }[]> {
    if (!isUuid(serviceId)) throw new OrganisationValidationError(['serviceId']);
    const r = await tx.query(
      `SELECT DISTINCT ON (t.key, t.language) t.key, t.version, t.language, t.body_document_id
         FROM organisation.service_required_consent rc
         JOIN organisation.consent_template t ON t.key = rc.consent_template_key AND t.status = 'published'
        WHERE rc.service_id = $1
        ORDER BY t.key, t.language, t.version DESC`,
      [serviceId],
    );
    return r.rows.map((x) => ({
      key: str(x.key),
      version: num(x.version),
      language: str(x.language),
      bodyDocumentId: str(x.body_document_id),
    }));
  }

  /** The latest published questionnaire version for the key, or null. */
  async questionnaireTemplate(
    tx: Tx,
    key: string,
  ): Promise<{ key: string; version: number; schema: unknown } | null> {
    const r = await tx.query(
      `SELECT key, version, schema FROM organisation.questionnaire_template
        WHERE key = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const x = r.rows[0];
    return x === undefined ? null : { key: str(x.key), version: num(x.version), schema: x.schema };
  }

  // --- licensing (BD-17) ------------------------------------------------------------------------------------------

  /**
   * `refused_not_operating` unless the patient's state has a telehealth-allowed operating state in effect today; with none
   * configured it refuses every video booking (fails closed until D-2). Then `refused_not_licensed` unless a clinician is
   * licensed in the patient's state. The mode (`refuse` or `flag`) is the caller's decision from `telehealth_licensing_mode`.
   */
  async licensingCheck(
    tx: Tx,
    clinicianStates: readonly string[],
    patientState: string,
  ): Promise<LicensingResult> {
    const state = patientState.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw new OrganisationValidationError(['patientState']);
    const r = await tx.query(
      `SELECT telehealth_allowed FROM organisation.operating_state
        WHERE jurisdiction_code = $1 AND effective_from <= current_date ORDER BY effective_from DESC LIMIT 1`,
      [state],
    );
    if (r.rows[0]?.telehealth_allowed !== true) return 'refused_not_operating';
    return clinicianStates.some((c) => c.trim().toUpperCase() === state)
      ? 'allowed'
      : 'refused_not_licensed';
  }
}
