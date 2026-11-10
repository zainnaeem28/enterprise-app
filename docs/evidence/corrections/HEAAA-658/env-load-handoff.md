# env-load-handoff (HEAAA-658, RA-R1-18) — ACCEPTANCE R2 correction

Status: **ENV-LOAD, k6 and ENV-DR are NOT provided (blocked, owner named below). The `r133` N-1 baseline tag IS provided (local).**
Nothing here is a pass of any TC-PERF, TC-REC or N-1 case. Those cases stay `Blocked` (TEST-CASES 11.2: never run smaller and report a pass).

## 1. What was checked on this host (executed 2026-11-10)
| Check | Result |
| --- | --- |
| `df -h /` | 48 G volume, 41 G used, **4.7 G free (90 %)** |
| `command -v k6 docker psql pg_ctl postgres` | none installed; only `node`, `pnpm` |
| Memory / CPU | ~8 GB RAM (~2.8 GB available), 4 cores |
| AWS account for `loadtest` / `restore-test` / DR rehearsal | none authorised for this project: no G3 for any environment (QUALITY-RELEASE-PLAN 0.3: only `ENV-INT/ci` exists under G2). Agent-environment AWS variables belong to the agent runtime, were not used, and are not a deployment credential |

## 2. ENV-LOAD — blocker
DEVOPS-PLAN 3.4 defines `loadtest` as production-equivalent: Multi-AZ RDS with the production class, production Fargate sizes (api 2–8, worker 2–4), ALB/WAF, synthetic data at year-1 volume with **~400 GB of audit partitions** (+ ~400 GB snapshot), and in-VPC Fargate k6 generators. Needs: an AWS account/IaC workspace, an owner-approved cost (DEVOPS-PLAN 13.1 — owner approval is a stated precondition), and exact-environment G3 before DevOps receives credentials.

Shortfall against this host (exact): the data set alone is ~400 GB versus 4.7 GB free (**~395 GB short**, ~85×); no Postgres 17/RDS Multi-AZ, no Docker, no k6 binary. Even a scaled-down local rig cannot meet "≥100 % of stated values with 2× sustained / 3× burst headroom" and would be invalid evidence by TEST-CASES 11.2.

Smallest viable alternative (not a substitute for the cases): a single-region `loadtest` stack built from the existing IaC for the 3–5 day window in DEVOPS-PLAN 13.1 (figures there are **unverified** list prices; I do not restate them as quotes), data generated in-VPC with fixed seed, snapshot kept, IaC destroyed after. There is no cheaper valid shape; TC-PERF-04 alone (≈2 M audit events/day over a 400 GB hot window) fixes the size.

**Owner / what is needed (blocker):**
1. Owner: approve the `loadtest` cost (13.1) and authorise the AWS account/region; human Architect/counsel: accept the k6 AGPL-3.0 licence as an unmodified test tool (DEVOPS-PLAN 16 item 20).
2. Gate: a G3 for the named environment `loadtest` (and for `ENV-DR` in `us-west-2`, `staging` account); credentials are issued to DevOps only after that.
3. TC-PERF-06 (250 concurrent video visits) additionally needs a chosen video vendor sandbox (out of DevOps scope until a vendor exists); k6 driving the SSE alert stream is **Unverified** (DEVOPS-PLAN 14) and may need a small custom client.
4. TC-REC-03/-07 need Multi-AZ and a second region; TC-REC-08 needs a named on-call rota (DEP-15). None exist yet.

A deferral of TC-PERF/TC-REC needs an explicit gate ruling with an owner; it cannot cover NFR-12..19 (those are not load cases and are not affected by this document).

## 3. How QA runs, once provisioned (planned, not executed)
Scenarios are JavaScript files in the repository (none exist yet — to be written as part of the `loadtest` build ticket); `k6 run` thresholds on p95 and error rate set a non-zero exit status; the summary, raw output, k6 version, script revision, candidate commit and sizing are stored as artifacts (DEVOPS-PLAN 5.3). Endpoint URLs and the results bucket will be recorded here after provisioning; **no endpoints exist today**. No credentials appear in this document; access is by IAM role named in the G3 package.

## 4. Teardown and cost
Teardown = IaC destroy after the window, snapshot kept, cost compared with the budget alarm (DEVOPS-PLAN 3.4). Cost today: **US$0 incurred** (nothing provisioned). Planned cost: DEVOPS-PLAN 13.1 (unverified).

## 5. N-1 baseline tag — provided
- Tag: **`r133`** (annotated, local to the repository; **not pushed** — publishing a release-shaped tag to `origin` is outward-facing and needs the release owner).
- Points to `c067035` (first-parent count 133 = release number 133, so `r<N>` matches the numbering rule in `scripts/release/lib/release-number.mjs`). Tag object message states it is an N-1 rehearsal baseline, **not a published release** (no manifest, image or G3 exists).
- It is an ancestor of the acceptance candidate `cdc388d` and of this branch's HEAD. Executed: `previous_release_tag` (scripts/ci/migration-check/lib.sh) prints `r133`; the commit has `db/tools/migrate.mjs` (required by `prepare_previous_tree`).
- NOT executed: the N-1 run itself (`scripts/ci/migration-check/n-minus-1.sh`) — it needs PostgreSQL 17 with roles, which this host lacks. QA runs it in `ENV-INT/ci` (compose.ci.yml, F-03) with `REQUIRE_PREVIOUS_RELEASE_TAG=true`; the tag must exist in that clone (`git push origin r133` by the release owner, or fetch from this repository). Until it has run the N-1 result is unknown, not passed.
- Remove if not wanted: `git tag -d r133`.

## 6. Recoverable DB for TC-REC
Not provided: needs `ENV-DR` (above) and/or the `restore-test` account; no database engine exists on this host. Scripts exist (`scripts/restore/*`, `docs/runbooks/restore.md`) and are unit-tested only; no restore has been performed.
