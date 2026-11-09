#!/usr/bin/env bash
# Seeded-failure proof: for every CI job, introduce one defect into a THROWAWAY COPY of the working
# tree and require the job's entrypoint to exit non-zero. A control that cannot fail is not a control.
# The repository itself is never modified. Scanner binaries must already be on PATH or in
# $CI_TOOLS_DIR/bin (scripts/ci/install-tools.sh), semgrep via pip, pnpm via corepack, and
# `pnpm install` done. Synthetic secrets are assembled at run time so no key-shaped string is committed.
#
# Usage: scripts/ci/seed-failures.sh [job...]   (default: all)   Exit 0 only if every seed failed its job.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SRC="$CI_ROOT"
RESULTS="$REPORT_ROOT/seeded-failures.txt"
mkdir -p "$REPORT_ROOT"
: >"$RESULTS"
WORK_BASE="$(mktemp -d)"
trap 'rm -rf "$WORK_BASE"' EXIT
bad=0

# fresh_copy <name>: copy the tree (without .git, reports, caches) into a new git repo with one commit.
fresh_copy() {
  local d="$WORK_BASE/$1"
  mkdir -p "$d"
  tar -C "$SRC" --exclude=.git --exclude=reports --exclude=.ci-tools -cf - . | tar -C "$d" -xf -
  (cd "$d" && git init -q -b main && git add -A && git -c user.name=seed -c user.email=seed@example.invalid commit -q -m baseline)
  echo "$d"
}

# expect_fail <label> <dir> <command...>: the command must exit non-zero (a seeded defect was caught).
expect_fail() {
  local label="$1" dir="$2"
  shift 2
  local log="$WORK_BASE/${label//[^A-Za-z0-9]/_}.log" rc=0
  (cd "$dir" && REPORT_ROOT="$dir/reports" "$@") >"$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'PASS (job failed as required, rc=%s)  %s\n' "$rc" "$label" | tee -a "$RESULTS"
    awk '/::error::|error|violation|FAIL|findings|leaks found/ { print "      " substr($0, 1, 200); if (++n == 3) exit }' "$log" | tee -a "$RESULTS"
  else
    printf 'FAIL (seeded defect NOT caught)       %s\n' "$label" | tee -a "$RESULTS"
    tail -n 12 "$log" | sed 's/^/      /' | tee -a "$RESULTS"
    bad=$((bad + 1))
  fi
}

JOBS="${*:-all}"
want_job() { [ "$JOBS" = all ] || [[ " $JOBS " == *" $1 "* ]]; }

if want_job workflow-hygiene; then
  d="$(fresh_copy hyg-unpinned)"
  sed -i 's#actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 \# v7.0.1#actions/checkout@v4#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: tag instead of SHA" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-allowlist)"
  sed -i 's#actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1#evil/action@3d3c42e5aac5ba805825da76410c181273ba90b1#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: pinned but not on allow-list" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-swallow)"
  sed -i 's#run: scripts/ci/sbom.sh#run: scripts/ci/sbom.sh || true#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: '|| true'" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-colon)"
  sed -i 's#run: scripts/ci/sbom.sh#run: scripts/ci/sbom.sh || :#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: '|| :'" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-exit0)"
  sed -i 's#run: scripts/ci/sbom.sh#run: scripts/ci/sbom.sh || exit 0#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: '|| exit 0'" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-unlisted)"
  sed -i 's#container-scan, sbom\]#container-scan]#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: job missing from ci-status needs" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-coe)"
  sed -i '0,/    timeout-minutes: 10/s##    timeout-minutes: 10\n    continue-on-error: true#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: continue-on-error" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-noperm)"
  sed -i '/^permissions: {}$/d' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: no top-level permissions" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy hyg-secret)"
  sed -i 's#CI: .true.#CI: "true"\n  AWS_SECRET: ${{ secrets.AWS_SECRET_ACCESS_KEY }}#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: cloud secret on pull request" "$d" node scripts/ci/check-workflow-hygiene.mjs

  d="$(fresh_copy actionlint)"
  sed -i 's#\${{ github.workspace }}/.ci-tools#${{ github.workspac }}/.ci-tools#' "$d/.github/workflows/ci.yml"
  expect_fail "workflow-hygiene: actionlint (misspelt context property)" "$d" actionlint
fi

if want_job lint-types; then
  d="$(fresh_copy lint)"
  printf 'var seeded: any = 1;\nexport const x = seeded\n' >"$d/packages/kernel/src/seed.ts"
  expect_fail "lint-types: lint error (no-var / any)" "$d" pnpm lint

  d="$(fresh_copy types)"
  printf 'export const n: number = "not a number";\n' >"$d/packages/kernel/src/seed.ts"
  expect_fail "lint-types: type error" "$d" pnpm typecheck

  d="$(fresh_copy format)"
  printf 'export   const   x=1\n' >"$d/packages/kernel/src/seed.ts"
  expect_fail "lint-types: format error" "$d" pnpm format:check
fi

if want_job unit; then
  d="$(fresh_copy unit-fail)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="packages/kernel/package.json",j=JSON.parse(fs.readFileSync(p));
    j.scripts.test="mkdir -p $JUNIT_DIR && printf \"<testsuites><testsuite name=\\\"k\\\"><testcase name=\\\"a\\\"><failure message=\\\"boom\\\"/></testcase></testsuite></testsuites>\" > $JUNIT_DIR/kernel.xml && exit 1";
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: a failing test" "$d" node scripts/ci/run-unit.mjs

  d="$(fresh_copy unit-skip)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="packages/kernel/package.json",j=JSON.parse(fs.readFileSync(p));
    j.scripts.test="mkdir -p $JUNIT_DIR && printf \"<testsuites><testsuite name=\\\"k\\\"><testcase name=\\\"a\\\"><skipped/></testcase></testsuite></testsuites>\" > $JUNIT_DIR/kernel.xml";
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: a skipped test" "$d" node scripts/ci/run-unit.mjs

  d="$(fresh_copy unit-empty)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="packages/kernel/package.json",j=JSON.parse(fs.readFileSync(p));
    j.scripts.test="mkdir -p $JUNIT_DIR && printf \"<testsuites><testsuite name=\\\"k\\\"></testsuite></testsuites>\" > $JUNIT_DIR/kernel.xml";
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: an empty suite (zero test cases)" "$d" node scripts/ci/run-unit.mjs

  d="$(fresh_copy unit-noreport)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="packages/kernel/package.json",j=JSON.parse(fs.readFileSync(p));
    j.scripts.test="exit 3";
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: a suite that exits non-zero without writing a report" "$d" node scripts/ci/run-unit.mjs

  d="$(fresh_copy unit-noop)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="packages/kernel/package.json",j=JSON.parse(fs.readFileSync(p));
    j.scripts.test="echo no tests; exit 0";
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: a test script that runs nothing and exits 0" "$d" node scripts/ci/run-unit.mjs

  d="$(fresh_copy unit-noboundary)"
  (cd "$d" && node -e '
    const fs=require("fs"),p="package.json",j=JSON.parse(fs.readFileSync(p));
    delete j.scripts["test:boundary"];
    fs.writeFileSync(p,JSON.stringify(j,null,2));')
  expect_fail "unit: the root suite is missing (nothing runs)" "$d" node scripts/ci/run-unit.mjs
fi

if want_job build; then
  d="$(fresh_copy build)"
  printf 'export const n: number = "not a number";\n' >"$d/packages/kernel/src/seed.ts"
  expect_fail "build: compile error" "$d" pnpm build
fi

if want_job sast; then
  d="$(fresh_copy sast)"
  mkdir -p "$d/apps/api/src/modules/identity"
  cat >"$d/apps/api/src/modules/identity/seed.ts" <<'EOF'
import express from 'express';
const app = express();
app.get('/x', (req, res) => {
  res.send('<b>' + req.query.name + '</b>');
  eval(req.query.code as string);
  res.redirect(req.query.to as string);
});
EOF
  expect_fail "sast: eval of request data, reflected HTML, open redirect (ERROR + sensitive path)" "$d" scripts/ci/sast.sh
fi

if want_job secrets; then
  d="$(fresh_copy secrets)"
  k1="AKIA"
  k2="QYLPMST7BNRKV3XD"
  printf 'export const awsKey = "%s%s";\nexport const awsSecret = "%s";\n' "$k1" "$k2" "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzQ7hN4sXvT" \
    >"$d/packages/kernel/src/seed-secret.ts"
  (cd "$d" && git add -A && git -c user.name=seed -c user.email=seed@example.invalid commit -q -m "seeded synthetic secret")
  expect_fail "secrets: committed key-shaped string (PR range)" "$d" env SECRETS_RANGE="HEAD~1..HEAD" scripts/ci/secrets.sh
fi

if want_job deps; then
  d="$(fresh_copy deps)"
  mkdir -p "$d/seed-lock"
  cat >"$d/seed-lock/package-lock.json" <<'EOF'
{ "name": "seed", "lockfileVersion": 3, "requires": true,
  "packages": { "": { "name": "seed", "dependencies": { "lodash": "4.17.15" } },
    "node_modules/lodash": { "version": "4.17.15", "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" } } }
EOF
  expect_fail "deps: known-vulnerable lockfile (lodash 4.17.15)" "$d" env CI_LOCKFILE=seed-lock/package-lock.json scripts/ci/deps.sh

  d="$(fresh_copy deps-missing)"
  expect_fail "deps: missing lockfile" "$d" env CI_LOCKFILE=does-not-exist.yaml scripts/ci/deps.sh
fi

if want_job container-scan; then
  d="$(fresh_copy container)"
  mkdir -p "$d/apps/api"
  printf 'FROM node:24\nCOPY . /app\nCMD ["node","/app/index.js"]\n' >"$d/apps/api/Dockerfile"
  (cd "$d" && git add -A && git -c user.name=seed -c user.email=seed@example.invalid commit -q -m "seeded Dockerfile")
  expect_fail "container-scan: Dockerfile runs as root, no HEALTHCHECK" "$d" scripts/ci/container-scan.sh
fi

if want_job sbom; then
  d="$(fresh_copy sbom)"
  rm -f "$d/pnpm-lock.yaml" "$d/package.json" "$d"/apps/*/package.json "$d"/packages/*/package.json
  expect_fail "sbom: no packages to inventory (empty SBOM)" "$d" scripts/ci/sbom.sh
fi

if want_job ci-status; then
  d="$(fresh_copy status)"
  expect_fail "ci-status: a required job was skipped" "$d" env NEEDS_JSON='{"unit":{"result":"success"},"sast":{"result":"skipped"}}' node scripts/ci/check-needs.mjs
  expect_fail "ci-status: a required job failed" "$d" env NEEDS_JSON='{"unit":{"result":"failure"}}' node scripts/ci/check-needs.mjs
fi

echo
if [ "$bad" -eq 0 ]; then echo "all seeded defects were caught"; else echo "$bad seeded defect(s) NOT caught"; fi | tee -a "$RESULTS"
exit "$bad"
