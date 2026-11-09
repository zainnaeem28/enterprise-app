# INT03-F08d evidence (HEAAA-321)

Base: this branch at `8dd1f5f` merged with HEAAA-326 tip `9f40ed6` (migrations 2300/2301, ruling HEAAA-325 rev 3). Node 24.22.2, pnpm, PostgreSQL 17 (`ehr-test-db`). Synthetic data. Raw output in `raw/`.

Root cause: `ROOT-CAUSE.md`. The receiving location had no `staff_scope`, so `lock_patients` and `ensure_care_relationship` ended in PM008 -> 404. Fix per ruling: referral-bound `lock_referral_patient` / `ensure_referral_care_relationship` (migration 2300), wired through the patient service, `Tx.lockReferralPatient`, the lock-order check, and the front-door `decide()`.

Changes: `frontdoor-flows.dbtest.ts` (TODO test now asserts the real accept; the `seedTargetSight` stand-in is removed and no assertion is weakened), `referrals.ts`, `ports.ts`, `adapters.ts`, `patient/service.ts`, kernel `with-scope.ts`, `lock-order-check.ts` (+2 unit tests).
`decide()` order: referral lock, pending re-check, `ensureForReferral` on accept only, referral UPDATE, inbox UPDATE. A decided referral that is still readable is answered 409 `not pending` before the lock.

| Check | Result | Raw |
| --- | --- | --- |
| frontdoor-flows.dbtest before (r2) | TODO test marked todo (404) | `raw/frontdoor-flows-before.txt` |
| frontdoor-flows.dbtest after | 16 pass, 0 fail, 0 todo | `raw/frontdoor-flows-after.txt` |
| frontdoor.dbtest | 20 pass, 0 fail | `raw/frontdoor-dbtest.txt` |
| lint, format:check, typecheck, build, test:boundary | exit 0 | `raw/*.txt` |
| kernel unit / api unit | 141 / 201 pass, 0 fail | `raw/kernel-unit.txt`, `raw/api-unit.txt` |
| `db/tools/db-test.mjs` | 42 pass, 1 fail: the pre-existing `messaging.is_*` M-5 definer item, same as HEAAA-326 baseline | `raw/db-test.txt` |

Limitations: T-RA-33/34 (call-order unit test and single-call-site static check) are covered by the flows dbtest and the lock-order unit tests, not by a dedicated mocked-order test. Not reviewed, not integrated.
