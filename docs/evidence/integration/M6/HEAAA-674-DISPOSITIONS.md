# HEAAA-674 branch dispositions

Integration branch: `HEAAA-674-integration` (PR #16). "Ancestor" = tip is an ancestor of the integration branch HEAD.

| Branch | Tip | Ancestor | Disposition |
| --- | --- | --- | --- |
| `HEAAA-10-sdlc-discovery-align-consolidate-discovery-findings` | 014a389 | yes | superseded draft; -s ours; absent files imported |
| `HEAAA-11-sdlc-g1-g1-requirements-and-architecture-direction` | f8d3d6e | yes | superseded draft; -s ours |
| `HEAAA-117-sdlc-ticket-do-11-load-test-environment-and-k6-harness-plumbing` | 9d68fcf | yes | merged (merge commit). Withheld from the tree, pending correction: `infra/modules/loadtest/**`, `.github/workflows/loadtest-{run,reaper}.yml`, `docs/loadtest-workflow.md`. The module was written against the pre-INT04-F37 compute/edge interfaces; on this base `tofu validate` fails (`public_subnet_ids` unsupported; edge now needs `integrations_certificate_arn`, `vpc_id`, `alb_security_group_id`, `waf_log_group_arn_integrations`). Restore from the branch tip after DevOps updates it. Kept: `tests/load/harness/**`, compute/database list-to-map change (tofu tests pass), `sg-wiring` example. |
| `HEAAA-12-sdlc-shared-boundaries-establish-shared-module-data` | d14ed7f | yes | superseded draft; -s ours |
| `HEAAA-13-sdlc-technical-design-design-erds-modules-api-and-f` | 38f778c | yes | superseded draft; -s ours; absent file imported |
| `HEAAA-14-sdlc-ux-design-design-brand-responsive-screens-and-` | 9dcb7aa | yes | merged (merge commit) |
| `HEAAA-140-sdlc-ticket-qa-04-automated-cases-booking-calendar` | e41105c | yes | merged (merge commit) |
| `HEAAA-142-sdlc-ticket-sec-07-pre-candidate-security-assessme` | d8df8bb | yes | merged (merge commit) |
| `HEAAA-143-sdlc-ticket-qa-05-automated-cases-telehealth-audit` | f5cbba4 | yes | merged (merge commit) |
| `HEAAA-144-sdlc-ticket-qa-03-automated-cases-identity-authori` | 00faee1 | yes | merged (merge commit) |
| `HEAAA-145-sdlc-ticket-qa-06-automated-accessibility-and-brow` | df3699c | yes | merged (merge commit) |
| `HEAAA-146-sdlc-ticket-qa-07-load-resilience-and-recovery-scr` | 8efad43 | yes | merged (merge commit) |
| `HEAAA-15-sdlc-qa-plan-write-human-executable-and-automated-t` | 39d881a | yes | superseded (pre-G2 TEST-CASES); -s ours |
| `HEAAA-16-sdlc-devops-plan-plan-environments-ci-cd-backup-obs` | b78a8b6 | yes | superseded (pre-G2 DEVOPS-PLAN); -s ours |
| `HEAAA-196-int02-r2-f09-fix-documents-tc-doc-05-order-depende` | 60e9a63 | yes | merged (merge commit) |
| `HEAAA-2-sdlc-intake-resolve-source-authority-and-score-intak` | ec31b95 | yes | merged (merge commit) |
| `HEAAA-233-int-02-r9-integrator-re-run-on-candidate-e7f06fb-r` | e432ad5 | yes | merged -s ours + INT-02-RESULT-r9/r10.md; 539 raw logs intentionally excluded (no decision to bulk merge); raw logs kept at origin archive/ ref |
| `HEAAA-243-int-02-r11-integrator-re-run-on-candidate-daa90a0-` | 94cb6b7 | yes | merged -s ours + INT-02-RESULT-r11.md; 720 raw logs intentionally excluded; kept at origin archive/ ref |
| `HEAAA-265-sdlc-ticket-fe-04a-patient-portal-accept-brand-sit` | da9d3e0 | yes | merged (merge commit) |
| `HEAAA-29-sdlc-qa-execution-execute-full-acceptance-cases-and` | 19cea0d | yes | merged (merge commit) |
| `HEAAA-3-sdlc-intake-decision-intake-start-update-provisional` | 071ff67 | yes | merged (merge commit) |
| `HEAAA-30-sdlc-quality-security-run-mandatory-tests-scans-and` | de0b9ed | yes | merged (merge commit) |
| `HEAAA-33-sdlc-release-plan-prepare-exact-artifact-environmen` | db2c299 | yes | merged (merge commit) |
| `HEAAA-343-sdlc-ruling-a-4-renumber-resolve-duplicate-amendme` | 60875f6 | yes | superseded as-is: main already uses A-5 for the audit-anchor amendment (HEAAA-437), so renaming the referral amendment to A-5 would collide. -s ours. Residual: main still says "the two A-4 amendments"; naming only, needs an Architect decision, no behaviour impact. |
| `HEAAA-4-sdlc-research-research-five-relevant-products-or-rec` | 0fe913d | yes | merged (merge commit) |
| `HEAAA-412-sdlc-fix-int04-f02-register-admin-worker-handlers-` | aa17a39 | yes | merged: documentation (DEVOPS-PLAN 16.2, SB-A4/A5, F02b decision log, ARCHITECTURE A-6/A-7). Code commits (abbdd6b etc.) resolved to main: admin_event handler already present.  |
| `HEAAA-413-sdlc-review-int04-f02-independent-review-backend-o` | 6534771 | yes | merged (merge commit) |
| `HEAAA-414-sdlc-review-int04-f02-independent-review-security-` | 6534771 | yes | merged (merge commit) |
| `HEAAA-415-sdlc-fix-int04-f03-wire-admin-portal-fe-17-fe-13-f` | 060d6a0 | yes | superseded: main StaffApp already wires admin portals; ui tokens (--realm-admin) identical on main. -s ours. |
| `HEAAA-48-sdlc-design-align-fix-architect-al-01-al-04-contrac` | 481f32a | yes | superseded draft (pre-G2); -s ours |
| `HEAAA-49-sdlc-design-align-fix-ui-ux-al-04-prompt-form-rule-` | fd1e92d | yes | superseded (pre-G2 design docs); -s ours |
| `HEAAA-491-sdlc-fix-int04-f16-provide-isolated-postgresql-17-` | 6e3a10e | yes | merged (merge commit) |
| `HEAAA-5-sdlc-business-analysis-map-actors-journeys-rules-and` | 8440f8a | yes | merged (merge commit) |
| `HEAAA-50-sdlc-design-align-fix-devops-al-04-confirm-al-05-al` | 46781a0 | yes | superseded (pre-G2); -s ours |
| `HEAAA-51-sdlc-design-align-fix-qa-al-05-al-08-sa-tc-06-singl` | db4de04 | yes | superseded (pre-G2); -s ours |
| `HEAAA-535-int04-f29` | aeda453 | yes | superseded: main scripts/ci/admin-run.mjs asserts realm admin_pool and audience staff. -s ours. |
| `HEAAA-551-int04-f32` | 0b18197 | yes | superseded: main AuditLog.tsx has nextMinute default To. -s ours. |
| `HEAAA-6-sdlc-prd-draft-write-prd-revision-for-parallel-revie` | 4e0d604 | yes | superseded: PRD draft 1 (11-04); main has the G2-approved PRD (F-00 bd6de63, 11-05). Merged with strategy ours, nothing imported. |
| `HEAAA-620-sdlc-review-int-05-r2-independent-review-of-int05-` | db2ed19 | yes | intentionally excluded: one empty file named x. Merged -s ours. |
| `HEAAA-65-sdlc-ticket-sec-01-cybersecurity-review-of-identity` | 66a2938 | yes | merged (merge commit) |
| `HEAAA-675-renumber-0905` | 037ff95 | no | NOT merged here: owned by open ticket HEAAA-675 (main CI red, migration 0905 out of order). Not touched to avoid stepping on active work. |
| `HEAAA-70-sdlc-ticket-qa-01-test-errata-revision-tc-api-dupli` | dab63f4 | yes | merged (merge commit) |
| `HEAAA-8-sdlc-architecture-overview-review-technical-feasibil` | 53fc277 | yes | superseded draft (ARCHITECTURE conflicts with G2 version); merged -s ours, 1 absent file imported |
| `HEAAA-87-sdlc-ticket-do-04-iac-identity-secrets-and-ci-trust` | 1ffd306 | yes | merged (merge commit) |
| `HEAAA-9-sdlc-discovery-security-assess-discovery-threats-and` | cabe41f | yes | merged (merge commit) |
| `origin/HEAAA-10-sdlc-discovery-align-consolidate-discovery-f` | 014a389 | yes | superseded draft; -s ours; absent files imported |
| `origin/HEAAA-117-sdlc-ticket-do-11-load-test-environment-and` | 15c52dd | yes | merged (merge commit) |
| `origin/HEAAA-14-sdlc-ux-design-design-brand-responsive-scree` | 8b2d3f4 | yes | merged (merge commit) |
| `origin/HEAAA-142-sdlc-ticket-sec-07-pre-candidate-security-a` | d8df8bb | yes | merged (merge commit) |
| `origin/HEAAA-265-sdlc-ticket-fe-04a-patient-portal-accept-br` | da9d3e0 | yes | merged (merge commit) |
| `origin/HEAAA-29-sdlc-qa-execution-execute-full-acceptance-ca` | 19cea0d | yes | merged (merge commit) |
| `origin/HEAAA-30-sdlc-quality-security-run-mandatory-tests-sc` | de0b9ed | yes | merged (merge commit) |
| `origin/HEAAA-343-sdlc-ruling-a-4-renumber-resolve-duplicate-` | 60875f6 | yes | superseded as-is: main already uses A-5 for the audit-anchor amendment (HEAAA-437), so renaming the referral amendment to A-5 would collide. -s ours. Residual: main still says "the two A-4 amendments"; naming only, needs an Architect decision, no behaviour impact. |
| `origin/HEAAA-412-sdlc-fix-int04-f02-register-admin-worker-ha` | a8afc78 | yes | merged: documentation (DEVOPS-PLAN 16.2, SB-A4/A5, F02b decision log, ARCHITECTURE A-6/A-7). Code commits (abbdd6b etc.) resolved to main: admin_event handler already present.  |
| `origin/HEAAA-432-sdlc-decision-int04-f10-owners-closure-or-r` | d98ad50 | yes | merged (merge commit); INT04-F10-DECISION-LOG.md |
| `origin/HEAAA-65-sdlc-ticket-sec-01-cybersecurity-review-of-i` | 66a2938 | yes | merged (merge commit) |
| `origin/HEAAA-675-renumber-0905` | 037ff95 | no | NOT merged here: owned by open ticket HEAAA-675 (main CI red, migration 0905 out of order). Not touched to avoid stepping on active work. |
| `origin/HEAAA-9-sdlc-discovery-security-assess-discovery-thre` | cabe41f | yes | merged (merge commit) |
| `origin/INV-9-sdlc-discovery-security-assess-discovery-threat` | 367c7ac | yes | old company prefix, earlier discovery security text; merged -s ours, one file imported as docs/security/DISCOVERY-SECURITY.md (differs from HEAAA-9 SECURITY-ASSESSMENT.md); branch listed for deletion |
| `origin/fix/int04-f28` | cb41239 | yes | merged (merge commit) |

## Not merged, recorded

- `origin/fix/int04-f28`: superseded. main `scripts/ci/admin-run.mjs` sends `x-client-release` (lines 258, 388). Merged -s ours, so it is now an ancestor; listed for deletion.
- `origin/INV-9-...`: merged -s ours (see table); listed for deletion.
- `ci/*` probe branches and `dependabot/*`: not part of R3. ci/* probes listed for deletion; dependabot is a separate decision.
- `paperclip/rescue/HEAAA-279/*`: throwaway CI probe ("not for merge"), excluded. `paperclip/rescue/HEAAA-640/*`: dirty-workspace rescue (199 files), excluded. Both preserved under `origin/archive/`.
- 34 local-only branches pushed to `origin/archive/<name>` as backup before any merge.
