# INT04-F19: tooling and evidence (HEAAA-497)

Branch from HEAAA-139 tip `4360d7e`. Not merged, not independently reviewed yet. No credentials in any file.

## Installed (own environment, `/tmp/ci-tools`, nothing on the host)
| Tool | Version | Verification |
|---|---|---|
| OpenTofu | 1.13.9 | sha256 `bc44eb6b…c539ce` equals vendor `tofu_1.13.9_SHA256SUMS`; pinned in `scripts/ci/tools.lock` |
| tflint (bundled terraform ruleset 0.17.0) | 0.66.0 | sha256 `22be11ca…9d1e2e` equals vendor `checksums.txt`; pinned in `tools.lock` |
| Chromium headless shell via `@playwright/test` | 1.64.1 (same pin as the apps), Chromium 156.0.8078.4 | Playwright's downloader; no vendor checksum compared. Shared libraries (81 Debian trixie packages) fetched through apt (signature-verified) and unpacked with `dpkg -x`, no root |

## How to run
- `scripts/ci/install-tools.sh tofu tflint` (now handles `.zip`), `CI_TOOLS_DIR` selects the directory.
- `scripts/ci/install-browser.sh`, then `eval "$(scripts/ci/install-browser.sh --env)"`.
- `node scripts/ci/browser-smoke.mjs apps/staff <out-dir> <free-port> / /sign-in` (builds nothing; needs `vite build` first; uses its own port because 4173 was occupied in this environment by another process, so `playwright test` with the apps' fixed port failed with "already used").
- IaC: per root `tofu init -backend=false && tofu validate`; `tflint --chdir=<dir> --config=<repo>/infra/accounts/.tflint.hcl`.

## Evidence (`docs/evidence/integration/M5/raw/f19/`)
- `iac.log`: `tofu fmt -check -recursive infra` exit 0. `tofu validate`: all 19 roots/modules "valid", no other output.
- `tflint.log`: 14 directories with their own config and the 6 account roots (using `infra/accounts/.tflint.hcl`, since the account roots have no config of their own): all exit 0, no findings. The AWS ruleset plugin is not enabled in these configs, so only the terraform ruleset ran. `tofu test` for modules was not run.
- `browser-smoke.log`, `screens/`: the browser works. Built staff app served locally, `/` and `/sign-in` rendered (HTTP 200) and screenshotted.

## Not done / limitations
- **Real admin-path screenshots (BUILD_REVIEW) are not produced.** They need the staff app, API, PostgreSQL and the local IdP running together (the M4 r11 journeys in `docs/evidence/integration/M4/raw/int03-r11/ui` show the pattern, port 4675 and IdP 9301). This task provides the browser; it did not stand up that stack. Owner: Frontend with Integrator, using the commands above. The F17 failing test must be fixed first for a green integration-db.
- **N-1: no previous release tag exists.** `git tag -l` is empty and there is no `origin` remote in this worktree (385 commits, no release ever cut). So an N-1 comparison is impossible, not skipped. Proposed baseline: Release Reviewer / Integrator tags the first accepted candidate (e.g. `release-0001` per `scripts/release/release-number.mjs`) after ACCEPTANCE; until then N-1 is evaluated as "first release: no prior version, migrations apply to an empty schema", plus the migration-check against the previous milestone's merge commit (M4 integration tip) as a stand-in baseline, labelled as such.
