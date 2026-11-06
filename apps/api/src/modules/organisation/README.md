# organisation module (BE-03)

Owner: Backend Engineer. Migrations `0300`-`0302`, API side here. Design: ARCHITECTURE 21.2, 22.5, 22.5.1, 24, 31.4, 38.2 item 17;
PRD F-AD-01..05, 7.2, BR-23 extension, D-3.

## What it does

| Interface                                                             | Behaviour                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setting(tx, key, location?)`                                         | Reads `kernel.setting` (location row, else organisation row). A missing key throws `SettingNotConfiguredError` (`kernel.unavailable`): nothing falls back to a value in code.                   |
| `applySettingDefaults(tx, jobId?)`                                    | Worker job (audience `system`, job scope `org`): seeds `settings-catalogue.ts` (31.4 / PRD 7.2 proposals) with `ON CONFLICT DO NOTHING`. Never overwrites; skips the two keys with no proposal. |
| `setSetting(tx, key, value, location?)`                               | Admin change of a catalogued key; value checked against the key's schema. `pre_auth` keys are refused by the policy (reference data only).                                                      |
| `directoryLocations / directoryServices / directoryServiceClinicians` | Read only the C0 views of 22.5.1 (public and patient audiences).                                                                                                                                |
| `location`, `services`, `createService`                               | Staff/system configuration reads; `createService` enforces the neutral patient-visible name (422 `organisation.neutral_name_required`), the table CHECK enforces it again.                      |
| `bookingPolicy(tx, service, location?)`, `createBookingPolicy`        | Effective policy (location row, else service row, else built from settings). `late_change` defaults to `block` (D-3); `fee` is stored only. Nothing in this module charges.                     |
| `consentTemplatesRequired`, `questionnaireTemplate`                   | Latest published versions.                                                                                                                                                                      |
| `licensingCheck(tx, clinicianStates, patientState)`                   | `refused_not_operating` unless an operating state in effect allows telehealth (empty table = refuse all, D-2), then `refused_not_licensed`.                                                     |

## Database

- `0300` sixteen tables of 22.5 (the ticket card says 34; 22.5 lists 16, see N-BE03-1), 21.1 columns, `class=` tags, `row_version` triggers, immutable published templates.
- `0301` FORCE RLS, T-CONF / T-CONF(staff) read, admin_pool-only write (worker: `jurisdiction` reference data), grants.
- `0302` `directory_ro` schema rights and column grants (exactly the 22.5.1 list), seven T-DIRECTORY policies, seven owner-rights views handed to `directory_ro`, `SELECT` for `app_api`.
- No DML in any migration (SBR-17). Defaults and the jurisdiction list are seeded by worker jobs.

Tests: `organisation.dbtest.ts` (real PostgreSQL 17, migrations run by the real pipeline as `app_owner`):
`node --test dist/src/modules/organisation/organisation.dbtest.js` with `EHR_TEST_ADMIN_URL` set.

## Open notes (for Orchestrator / Architect / F-03 owner)

- **N-BE03-1 (ticket card).** "The 34 tables of 22.5": 22.5 defines 16 (`organisation`, `jurisdiction`, `location`, `room`, `opening_hours`, `holiday`, `service`,
  `service_location`, `service_clinician`, `booking_policy`, `consent_template`, `questionnaire_template`, `service_required_consent`, `feature_flag`, `banner`,
  `operating_state`). All 16 are built. No other `organisation` table is specified, so none was invented.
- **N-BE03-2 (two of the nine views).** `identity.public_clinician` and `scheduling.public_clinician_location` read `identity.principal`/`staff_profile` and
  `scheduling.availability_template`, which do not exist until BE-04 and the scheduling tickets (this ticket is a prerequisite of both). They cannot be created
  here, and `0300-0399` is the only range allowed. Their creation, T-DIRECTORY policies, `directory_ro` schema grants on `identity`/`scheduling` and column
  grants belong to those tickets (a `CREATE VIEW ... ALTER VIEW OWNER TO directory_ro` after the grants, as in `0302`). **The "nine views" acceptance is met for the
  seven views of this schema only.**
- **N-BE03-3 (db/tools, outside BE-03 paths).** The shared catalog check needs: `ownerRightsViews` and `publicPolicies` extended with the seven views and seven
  `*_directory` policies, and the M-3 table-level-SELECT clause must not count a view's own owner (an owner always has SELECT on its view). The exact diff is
  `catalog-lists.requested.patch`; with it applied `db/tools/db-test.mjs` passes 29/29 and `catalog-check.mjs` reports no violation. Without it the existing
  checks M-3, M-4-views, M-5-directory and M-5-public fail on the new objects (and the test here asserts that these are the only failures).
- **N-BE03-4 (read variants).** 22.5 says "RLS T-CONF" for the schema and also that patients read the directory through the views. `room`, `service`,
  `service_location`, `service_clinician` therefore use T-CONF(staff) (staff and system), so a patient transaction cannot read `internal_name`, prices or fees
  from the base table. If scheduling needs `buffer_min` or the duration in a patient transaction (hold), the Architect must say whether to widen `service` to plain
  T-CONF or expose the value another way.
- **N-BE03-5 (columns).** `booking_policy` has an `id` column (not listed in 22.5) so rows can be referenced; `cutoff_hours` and `max_future_per_patient` are
  NOT NULL without a database default (the service fills them from the settings), `hold_minutes` and `no_show_grace_min` are overrides (null = use the setting);
  the video grace comes from the `no_show_grace_min` setting. `holiday` and `feature_flag` also have an `id`. `organisation` and `jurisdiction` carry `organisation_id`
  (`= id` for `organisation`) so one policy template covers every table. `questionnaire_template` requires `approved_by_note` for a published version whose
  `schema.red_flag_rules` is a non-empty array (the design names the rule, not the key; `red_flag_rules` is an assumption).
- **N-BE03-6.** `settings-catalogue.ts` is seed data, applied by a worker job nobody schedules yet (the job registration belongs to the worker/integration step).
  Until it runs, `setting()` fails closed. The `organisation.config_changed` event (24) is not published here: no admin write route exists yet (BE-23).
