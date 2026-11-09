# INT03-F09a result

Root cause (on merged tip 88699bd): migration 2300 (F08d) makes `patient.guard_care_relationship_origin` require a sent internal referral with a pending inbox row at the location for `reason='referral'`. The fixture in `binding.dbtest.ts` ('staff accept a referral at their own location only') called `ensure_care_relationship(..., 'referral')` with no referral, so it raised `no pending referral of this patient to this location` (before.txt: 10/11, that test failing).

Fix (test only): the fixture has a sender (A1 staff) write a draft, send it and add the inbox row to A2 under the app_api grants; accept goes through the referral-bound path `lockReferralPatient` + `patient.ensure_referral_care_relationship`. Assertions kept/added: staff of another location (B1) refused on `ensure_care_relationship` (42501) and on the bound path (PM008); staff of A1 only refused (PM008); no referral relationship row after refusals; staff of A1+A2 accept and exactly one `reason='referral'` row at A2.

Evidence: before.txt (binding.dbtest: 11 tests, 10 pass, 1 fail); after.txt (11/11); api-integration-after.txt (all api *.dbtest + unit suites, concurrency 1: 1085 pass, 0 fail). No migrations or product code changed.
