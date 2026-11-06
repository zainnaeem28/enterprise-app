# F-07 Foundation proof (HEAAA-81)

Status: **executed in CI; not yet independently reviewed; not integrated; not human-approved; nothing deployed.**

## Candidate

| Item | Value |
| --- | --- |
| Candidate commit (Dockerfiles + journey harness) | `9593424e000bbd2e2a829d270e74eef91dd2123c` on branch `HEAAA-81-…` (based on F-09 candidate `6313e52`, which already contains F-01…F-06, F-08) |
| Commit CI actually ran | `e24d08693eb59ae79d42e07d7eea01e865cbdbd6` on throwaway ref `ci/HEAAA-81-9593424-b` = candidate + ONE added file, `.github/workflows/foundation-proof.yml` (copy: `foundation-proof.workflow.yml.txt`). The workflow is **not on the candidate branch and not for merge** (the allowed paths do not include `.github/`). |
| Evidence run | https://github.com/zainnaeem28/enterprise-app/actions/runs/42147074492 (conclusion `success`, single job `foundation-proof`) |
| Revision of this evidence | The submitted commit is the candidate plus this directory only (`docs/evidence/foundation/**`); no product or Dockerfile byte differs from the tested candidate |
| `pnpm-lock.yaml` sha256 | `fe5fc3b2942639ad7fb5c06a7a12457930183824e4f37a8fbec849e05d04f174` |
| `docker/Dockerfile.api` sha256 | `5df716024056310597bc208745349d57e88f87e86079a35b42351a4e6b2647d2` |
| `docker/Dockerfile.worker` sha256 | `e54838925a4b7341dd440ea089cf949d0f1c176ec1f03a40ae34fa4391f5846c` |

Raw reports are the artifact of that run, copied unmodified to `raw/` (file names below are relative to it).

## Tool versions (`raw/00-versions.txt`, `raw/06-playwright-version.txt`, `raw/trivy/tool-version.txt`)

Node v24.22.2 · pnpm 12.16.1 · Docker 28.0.4 · runner ubuntu-24.04 image 20261101.360.1 · Trivy 0.76.2 (sha256-verified install by `scripts/ci/install-tools.sh`) · Playwright 1.64.1 with Chromium · PostgreSQL 17 (service image pinned by digest `sha256:748a18a5…a6b3`) · base image `node:24.22.2-slim@sha256:01d566e8…70e9`.

## Results

| # | Check | Command (full text in the workflow copy) | Result | Raw report |
| --- | --- | --- | --- | --- |
| 1 | Clean frozen install | `find . -name node_modules` returned 0 before; `pnpm install --frozen-lockfile` | PASS: "Lockfile is up to date", supply-chain policy passed for 401 entries, done in 2.1 s | `00-versions.txt`, `01-install.txt` |
| 2 | Production build of every app | `pnpm build` (api, worker, staff, patient, site, cms, and the packages) then output existence checks | PASS: staff `dist/index.html` + assets, api `dist/src/main.js`, worker `dist/main.js`, patient/site/cms compiled | `02-build.txt`, `02-build-outputs.txt` |
| 3 | Container build | `docker build -f docker/Dockerfile.{api,worker} .` (repository-root context) | PASS: both images built; user `node`, HEALTHCHECK present, api 251.9 MB, worker 240.0 MB | `03-docker-build-*.txt`, `03-images.txt` |
| 4 | Container scan: config | Trivy `config`, then `scripts/ci/check-trivy-config.mjs` (blocks root user, missing HEALTHCHECK, any HIGH/CRITICAL misconfiguration) | PASS: 2 targets, no blocking misconfiguration | `trivy/config.json`, `trivy/config-result.txt` |
| 5 | Container scan: images | `trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` on each image (the flags of `scripts/ci/container-scan.sh`) | PASS (exit 0): no HIGH/CRITICAL finding **with a fix** in either image (OS packages and Node.js packages: 0 each) | `trivy/image-{api,worker}.json`, `trivy/image-result.txt` |
| 6 | Database migrated, queue installed | `scripts/ci/migration-check/prepare-db.sh ehr`; `installQueue()` as `app_owner` | PASS | `04-migrate.txt`, `04b-queue-install.txt` |
| 7 | Image smoke, real entry points, read-only root filesystem | API image: `/readyz` 200 `{"status":"ready"}`, `/healthz` 200, process uid 1000. Worker image: boots ("worker booted"), still running after 8 s, exit code 0 after SIGTERM | PASS | `05-image-smoke.txt`, `05-api-real.log`, `05-worker.log` |
| 8 | **Journey**: browser shell → same-origin API → PostgreSQL with scope setter and RLS → rendered result | Playwright 1.64.1, Chromium, against the BUILT `apps/staff/dist` served by `vite preview` with `/api` proxied to the API **container** (see "How the journey was run") | PASS (1 passed, 0 skipped, 0 flaky). Rendered: heading "Staff portal", region "Server connection" showing "Not found Reference for support: 3d95dae5-…". One `/api/v1/auth/session` call, status 404, `X-Client-Release: r1.000000000000`; no request left the origin; no console script error | `06-journey.txt`, `journey/journey-report.json`, `journey.png`, `06-api-journey.log` |
| 9 | Database half of the journey, as the API's own role `app_api` | `journey/rls-check.mjs` in the image | PASS 4/4: scoped read sees its organisation's counter row written by the journey (1 row, 1 hit); another organisation's scope sees 0 rows; inserting another organisation's row is refused with SQLSTATE 42501; with no scope set `app_api` sees 0 rows | `07-rls-check.txt` |
| 10 | No deploy | The workflow has one job, no environment, no secret, no cloud credential, `contents: read` only | PASS: nothing deployed | `08-no-deploy.txt` |

## How the journey was run, and its limits

`apps/api/src/main.ts` constructs the API with the in-memory rate limiter. `PgRateLimiter`, the only R1 code that reaches PostgreSQL through `KernelDb.withScope` on a request path, exists but is not wired into `main.ts` (no organisation exists before the identity module). To put the scope setter and RLS on the browser's path without editing product code (outside the allowed paths), `journey/api-with-scoped-limiter.mjs` is mounted read-only into the built **API image** and composes the same compiled modules as `main.ts` with `PgRateLimiter` instead. So the journey proves: the built shell, the built image's compiled API, the real PostgreSQL 17 schema, role `app_api`, `withScope`, and FORCE RLS on `kernel.rate_counter`, end to end. It does **not** prove that the production entry point (`main.js`) wires that limiter. Step 7 proves `main.js` starts and is ready, separately.

The "rendered result" is the API's 404 problem document, because no `auth/session` route exists yet.

## NOT proven

- **Real authentication.** There is no identity module; `GET /api/v1/auth/session` does not exist and answers 404. The first real authentication slice is INT-01. No sign-in, session, cookie, or permission-resolved request was exercised.
- Cloud, AWS, RDS, ECS, CloudFront, KMS, Secrets Manager, ECR push, image signing, SBOM attestation, provenance: none touched.
- Any vendor integration.
- Production entry point wired to the PostgreSQL rate limiter (see above).
- Image reproducibility (build twice and compare) was not attempted.
- Staff shell served from the container: the shell is served by `vite preview` in the runner, not from an image (no portal image exists; DEVOPS-PLAN covers portals as bundles).
- The `site`, `cms`, `patient` apps are placeholder builds (compile only); no browser journey exists for them.
- The worker ran with no task handlers registered (`tasks: 0`); no job was enqueued or executed in these containers (queue behaviour is covered by the kernel and worker DB tests in F-04/F-05, not re-proved here).
- Worker HEALTHCHECK is process liveness only (`process.kill(1,0)`): the worker has no HTTP surface.
- Image scan limitation: the gate ignores findings with no published fix. The all-severity report (`trivy/image-api-all-severities.txt`) lists 215 Debian 12.15 OS-package findings for the API image (LOW 82, MEDIUM 99, HIGH 33, CRITICAL 1, e.g. `zlib1g` CVE-2023-45853, status `will_not_fix`), none with a fix at scan time. The images are therefore **not** claimed vulnerability-free; they pass the DEVOPS-PLAN gate "critical/high with a fix available".

## Findings during the work (all handled or reported)

1. First image scan failed: six HIGH findings with fixes in `npm`'s bundled `brace-expansion` and `undici` (run 42145137492). Fixed in the Dockerfiles by removing npm, npx and corepack from the runtime stage (nothing installs packages at run time). Not suppressed, no ignore entry added.
2. Worker first start failed ("worker failed to start") until the queue schema was installed and `EHR_ORGANISATION_ID` was set. There is **no CLI or image entry point for `installQueue`**; the evidence job calls it from the workspace build. A release migration task (DEVOPS-PLAN 8) needs one.

## Requests to the Orchestrator (outside this ticket's allowed paths; not edited)

- `scripts/ci/container-scan.sh` builds each Dockerfile with context `$(dirname "$df")` = `docker/`; these Dockerfiles need the repository root as context. Until the script uses the root context, the PR `container-scan` job will fail on the first Dockerfile. This run built and scanned the images itself with the same Trivy flags.
- A `.dockerignore` at the repository root (the Dockerfiles defensively delete host `node_modules` after `COPY`, but `.git` is not copied by the explicit COPY lines).
- `tests/e2e/smoke/api-container.sh` still runs the Node base image with the workspace mounted; it can move to the real image after the script above is corrected.
- A queue-install entry point for the release migration task.
- Unchanged from F-09: `lint-types`, `unit`, `secrets` jobs red on the integration ref; no release tag exists.

## Review state

Authored by DevOps Engineer. DevOps Reviewer then Backend Reviewer must read the raw reports in `raw/` against the candidate. Round 0 of 3. No finding IDs yet.
