# organisation admin routes (BE-23)

Owner: Backend Engineer. Design: ARCHITECTURE 29.4 (organisation rows), 30, 31.4; PRD RA-R1-15, RA-R1-26; INT03-F17 condition 1(c).
Contract: `packages/contracts/openapi/organisation.yaml` (32 operations, all `200`, all `staff.` realm `admin_pool`).

## Routes

| Resource                                                    | Methods                         | Permission                            | Notes                                                                                                                |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/admin/locations`, `/rooms`, `/opening-hours`, `/holidays` | GET, POST, PATCH                | `organisation.location.manage`        | PATCH takes the id in the body and `If-Match` (428 absent, 412 stale)                                                |
| `/admin/services`                                           | GET, POST, PATCH                | `organisation.service.manage`         | `422 organisation.neutral_name_required`                                                                             |
| `/admin/booking-policies`                                   | GET, POST, PATCH                | `organisation.policy.manage`          | cut-off and cap default from the settings; `fee` is stored, never charged (D-3)                                      |
| `/admin/consent-templates`, `/questionnaire-templates`      | GET, POST, `POST /{id}/publish` | `organisation.template.manage`        | POST makes the next DRAFT version; publish is once (`412` after); red-flag rules need `approvedByNote` (>= 10 chars) |
| `/admin/feature-flags`                                      | GET, PUT                        | `organisation.flag.manage`            | per organisation or per location; `patient_messaging` cannot be enabled (below)                                      |
| `/admin/banners`                                            | GET, PUT                        | `organisation.banner.manage`          | no PHI guard (no `@`, no 9+ digit run), `startsAt < endsAt`                                                          |
| `/admin/settings`                                           | GET, PUT                        | `organisation.setting.manage`         | catalogued key, value checked against the key's schema                                                               |
| `/admin/operating-states`                                   | GET, PUT                        | `organisation.operating_state.manage` | upsert by (state, effective date)                                                                                    |

Lists: `limit` 1..100 (default 25) and an opaque offset `cursor`. Responses are `no-store`; single rows carry `ETag: W/"<rowVersion>"`.

## Guarantees

- **Authorization is the guard's:** every route declares `realm: admin_pool`, a catalogue permission and `elevation: true` (C1). Handlers repeat none of it; the table policies (admin_pool-only writes, FORCE RLS) are the second line.
- **Audit:** every accepted change writes `config_change` (who/realm/audience from the scope, `change: {before, after}`) in the same transaction as the change; if the audit write fails the change rolls back (tested). No-op writes record nothing.
- **Refusals** that matter (`patient_messaging` on, a pre-auth setting) are written with `recordDenied` after the business transaction ended.
- **Secrets:** no response field or audit `change` carries a secret-looking key (tested); the audit envelope itself refuses such keys. This module stores no secrets.
- **Concurrency:** PATCH is compare-and-set on `row_version`; flags, settings, operating states, template versions and opening hours serialise on an advisory/row lock (tested with parallel requests).
- **Errors carry codes and field paths only**, never the offending value or driver text. Database constraint failures map to `400` (`kernel.duplicate`, `kernel.unknown_reference`, `kernel.invalid_format`).

## INT03-F17 1(c): `patient_messaging`

`flag-rules.ts` is the schema rule: a write that sets `patient_messaging` to enabled (organisation-wide or per location) is refused with
`400 kernel.validation_failed` (`errors[0] = {path: '/enabled', code: 'kernel.invalid_value'}`), writes no `organisation.feature_flag` row, and
is audited as `denied` with who, the current value (`before`) and the attempt. Disabling it, or removing its row, stays allowed.
The refusal is lifted only by the deferred patient-messaging design change and its G2 delta (edit `FLAG_RULES`).

## Notes for the Orchestrator / Architect (contract-constrained choices)

- **N-BE23-1 (wiring).** The controller is not mounted: `apps/api/src/composition.ts` is outside this ticket's paths. The Integrator adds
  `createOrganisationAdminController({ service: new OrganisationAdminService({ db, audit, organisation }), scopeOf })` next to
  `createCatalogueControllers` (same `scopeOf`).
- **N-BE23-2 (removal without DELETE).** The contract has no DELETE and PATCH/PUT carry the id in the body, so removal is in-band:
  flags `{key, locationId?, remove: true}`, banners `{id, remove: true}`, holidays `{id, remove: true}`, opening hours
  `{locationId, weekday, opens, remove: true}` (PATCH + `If-Match`). A real DELETE would need a contract change.
- **N-BE23-3 (template elevation).** The contract marks template reads and draft creation as not elevated; the permission catalogue
  (`organisation.template.manage` has `needsElevation`) makes the guard demand the grant anyway, which also matches this ticket's
  acceptance ("every admin route requires an elevation grant"). Stricter than the contract; no change needed unless the Architect wants the looser rule.
- **N-BE23-4 (not built).** 29.4 also lists vital ranges (`clinical.vital_range`, table not built: no clinical migration exists), message
  templates and alert settings (notifications), and service-location / service-clinician / required-consent links (no route in 29.4 or the
  contract). They are not part of the 32 organisation operations and stay with their owners' tickets.
- **N-BE23-5 (consent body document).** `bodyDocumentId` is not checked against the documents module (no foreign key by design, BD-02; a
  staff transaction cannot read patient documents). A template pointing at a missing document fails when a patient opens it; the
  document-upload ticket should provide the existence check or the admin UI should only offer known documents.
- **N-BE23-6 (cursor).** The cursor is an unsigned offset (the contract says HMAC-signed); it grants nothing a caller could not list anyway and is
  validated strictly. Signing needs a key from the composition root; request it if the Architect wants it.
- **N-BE23-7 (opening-hours overlap).** Overlapping intervals on one weekday are refused (`kernel.overlap`); the schema alone only prevents
  the same opening time twice.

## Tests

- `admin.test.ts`: parsing, If-Match, paging, error translation (no database).
- `admin.dbtest.ts`: HTTP through the real guard on PostgreSQL 17 with the real migrations (TC-AD-01..03, 06, 08..10, F17 1(c), integrity):
  `EHR_TEST_ADMIN_URL=... node --test dist/src/modules/organisation/admin/admin.dbtest.js`.
  TC-AD-04 (message templates) and TC-AD-05 (role + second approver) belong to the notifications and identity tickets.
