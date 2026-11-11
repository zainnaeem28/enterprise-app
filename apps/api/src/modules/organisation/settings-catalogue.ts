// The settings of ARCHITECTURE 31.4 with the PRD 7.2 proposals (all [G2 setting]: proposals until G2 fixes them).
//
// This file is the SEED DATA for kernel.setting, applied by `OrganisationService.applySettingDefaults` from a worker job
// (migrations are DDL only, SBR-17). It is not read at run time: every consumer reads the stored row through
// `OrganisationService.setting`, so a G2 value is a settings change (or an edit here plus a re-seed) and no code path
// carries a value of its own. Entries with `value: null` have no proposal and are never seeded (a read of one fails closed).
import type { SettingSchema } from './settings.js';

export interface CatalogueEntry {
  key: string;
  /** The proposed value, or null when the design gives none (legal or clinical input needed). */
  value: unknown;
  schema: SettingSchema;
  /** Readable before sign-in (22.1, TDR-11): session lifetimes, sign-in limits, egress ranges. */
  preAuth: boolean;
  source: string;
}

const e = (
  key: string,
  value: unknown,
  schema: SettingSchema,
  source: string,
  preAuth = false,
): CatalogueEntry => ({ key, value, schema, preAuth, source });

export const SETTING_CATALOGUE: readonly CatalogueEntry[] = [
  e('hold_minutes', 10, 'int>=1', 'PRD 7.2'),
  e('reminder_offsets', [48, 4], 'hours[]', 'PRD 7.2, BR-08'),
  e('previsit_send_offset', 72, 'hours', 'PRD 7.2'),
  e('waitlist_offer_minutes', { default: 30, within_24h: 15 }, 'waitlist_offer', 'PRD 7.2'),
  e('no_show_grace_min', { default: 15, video: 10 }, 'grace_minutes', 'PRD 7.2'),
  e('cutoff_hours', 24, 'int>=0', 'PRD 7.2 (per service)'),
  e('max_future_per_patient', 3, 'int>=1', 'PRD 7.2 (per service)'),
  e('calendar_stale_minutes', 15, 'int>=1', 'PRD 7.2'),
  e('staff_idle_minutes', 15, 'int>=1', 'PRD 7.2; 26.2', true),
  e('admin_idle_minutes', 10, 'int>=1', 'PRD 7.2; 26.2', true),
  e('patient_idle_minutes', 30, 'int>=1', 'PRD 7.2; 26.2', true),
  e('note_sign_deadline_hours', 24, 'hours', 'PRD 7.2'),
  e('note_sign_max_auth_age', 12, 'hours', 'BQ-8'),
  e('elevation_minutes', 15, 'int>=1', 'SEC-D-19 C1'),
  e('role_request_hours', 24, 'hours', 'C4'),
  e('enrolment_token_minutes', 30, 'int>=1', 'SHARED-BOUNDARIES 7.5', true),
  e('preregistration_days', 30, 'int>=1', '26.1', true),
  e('signin_ip_failures', 50, 'int>=1', '31.3, TDR-13; SEC-1', true),
  e('signin_clinic_ip_failures', 200, 'int>=1', '31.3, TDR-13; SEC-1', true),
  e(
    'clinic_egress_cidrs',
    [],
    'cidr[]',
    '31.3, TDR-13; SEC-1 (each clinic IT supplies its ranges)',
    true,
  ),
  // Owner ruling 2026-11-11 C item 3 (D-7, C-04): conservative product defaults, not legal or clinical advice; counsel confirms before go-live.
  e('proxy_age_of_majority', 18, 'int>=1', 'Ruling C item 3: guardian access ends on this birthday'),
  e('proxy_adolescent_min_age', 13, 'int>=1', 'Ruling C item 3: from this age to the age of majority a guardian keeps appointments only'),
  e('proxy_age_out_notice_days', 30, 'int>=1', 'Ruling C item 3: notice to the guardian this many days before access ends'),
  e('proxy_invite_hours', 72, 'hours', 'Ruling C item 3: an invitation code lives this long (Proposal)'),
  e('proxy_code_max_attempts', 5, 'int>=1', 'Ruling C item 3: wrong code entries before an invitation is locked (Proposal)'),
  e('btg_duration', 4, 'hours', 'Proposal'),
  e('assignment_lookback_months', 24, 'int>=1', 'BQ-5'),
  e('telehealth_licensing_mode', 'refuse', 'enum(refuse|flag)', 'RA-R1-28'),
  e('red_flag_escalation_minutes', null, 'int>=1', 'BR-10: the D-12a reviewer sets it; no default'),
  e('upload_max_mb', 20, 'int>=1', '31.1'),
  e('uploads_per_day', 20, 'int>=1', '31.1'),
  e('audit_export_max_rows', 1_000_000, 'int>=1', 'RA-R1-12'),
  e('audit_export_max_per_hour', 10, 'int>=1', 'SEC-D-19 C5, TC-SEC-20'),
  e('audit_retention_years', null, 'int>=1', 'NFR-13: legal input; no default'),
];
