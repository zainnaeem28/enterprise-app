# Clinical front door (BE-18)

Questionnaire template + response, triage with the red-flag rule, the consent gate with a recorded emergency exception, referrals
(send, inbox, accept/decline) and follow-up records. Vitals with out-of-range flags are BE-16's service, exposed on the check-in
route here. Migrations `1700`-`1702`. ARCHITECTURE 22.11, 25.5, 29.3; PRD RA-R1-06/07/08/29/30.

## Status of the acceptance parts

- **Mechanics: built and tested** on PostgreSQL 17 with the real roles, RLS, queue, identity guard and a real HTTP server
  (`frontdoor.dbtest.ts`, `frontdoor-flows.dbtest.ts`).
- **RA-R1-07 / RA-R1-08 acceptance, the red-flag rule text, the advice text and the escalation timing stay BLOCKED** (D-12a names no
  safety reviewer; PM-confirm-1). The rules in the tests are SYNTHETIC. The rule comes from the published questionnaire template
  (`red_flag_rules`, `emergency_advice`); nothing here ships a clinical rule. The escalation timer is the `staff_alert_setting` row
  for `red_flag`: with no row there is no timer.
- Lab sample collection booking is not built (D-4 default). Manual insurance verification is `patient.insurance_coverage` of BE-08
  (staff-only eligibility result, trigger `patient.guard_insurance`); this ticket adds no second record.

## Behaviour worth knowing

- Triage: assessments of one check-in form an append-only chain; the chain length is the ETag. A second assessment needs `If-Match`
  (428 without, 412 when stale). A red flag (rule match, or the nurse's own mark) raises the BE-07 alert for the on-duty doctor, or,
  with nobody rostered, every holder of the receive permission (and publishes `clinical.roster_gap`). The raiser is never a target
  unless nobody else can receive it. If nobody can receive it the triage is NOT saved (409). The alert, triage row and queue category
  commit together or not at all. A rule question left blank is rejected, never read as "no red flag".
- Consent gate (`ConsentGateService.start`, called by BE-17's `POST /encounters`): missing/outdated/withdrawn required consents give
  `409 clinical.consents_missing` with the template keys; with `emergencyException.reason` (10..500 chars) one append-only
  `clinical.consent_exception` row and an audit row are written.
- Referral accept/decline answer "not pending" (409) for a decided referral. The care relationship is created at the referral's own
  target location read from the locked row, never from the request.
- Merge: `repointPatient` / `exportPart` are registered through `registerFrontdoorParticipants` (replaces
  `registerClinicalParticipants` at the composition root; the registry takes one clinical participant). Open responses, draft/sent/
  accepted referrals and open/booked follow-ups move; triage and consent exceptions are K (counted, never touched).

## Limitations and requests to other owners (not changed here: outside the allowed paths)

1. **Referral accept cannot succeed on the combined base (blocking for INT).** `patient.lock_patients` and
   `patient.ensure_care_relationship` (BE-08, `0703`) call `patient.caller_sees()`, which is false for the receiving location (it has
   no care relationship yet). Accept ends in PM008 and returns 404. The real-path test is marked `todo`; the other referral tests put
   a `staff_scope` row in place to prove this side. BE-08/INT-02 must add the referral case to `caller_sees` (or the two functions).
2. **`notifications.staff_scope_allows_patient` is still the fail-closed stub** (BE-07 `1201`), so a staff red-flag alert insert is
   refused by RLS on the combined base. The test harness installs the intended body (`patient.staff_scope` check) in its throwaway
   database only. BE-08/INT-02 replace it with `CREATE OR REPLACE`.
3. The re-target of an unacknowledged red flag (`TriageService.retargetUnacknowledged`) runs in a patients-scope job, which cannot read
   `identity.principal`; there the roster alone decides (an inactive on-call doctor stays a target; targets are only ever added).
4. The worker handler for `notifications.alert_unacknowledged` -> `clinical.on_alert_unacknowledged` lives in `apps/worker` (outside
   the allowed paths). `FRONTDOOR_JOBS` and `registerFrontdoorHandlers` declare it.
5. Catalog checks `M-5-patient-guard` and `M-5-definer` list the five new tables and `clinical.frontdoor_guard_open_patient()` with
   the chart's: `db/tools/catalog-lists.mjs` is the owner's list to extend at integration. `follow_up` is a table 22.11 does not
   have (RA-R1-30 needs it): the Architect should confirm it.
6. `missingConsentTemplates` is carried in `errors[]` paths; the standard body does not serialise the extra member yet.

## Run the tests

```
pnpm --filter @ehr/api run build
cd apps/api
EHR_TEST_ADMIN_URL=postgres://postgres@HOST:5432/postgres node --test \
  dist/src/modules/clinical/frontdoor/frontdoor.dbtest.js dist/src/modules/clinical/frontdoor/frontdoor-flows.dbtest.js
```
