#!/usr/bin/env bash
# Upgrade path and N-1 suite (DEVOPS-PLAN 5.2, 8.1 rule 2): "the previous release's test suite passes against the new
# schema". With the previous release tag's code checked out in its own worktree, the candidate's db/migrations and
# db/roles REPLACE the tag's, and the tag's own database suites run against that schema. An old release that cannot
# run against the new schema fails here, before the rollout that would have depended on it.
# Usage: n-minus-1.sh <report-dir>      No tag => explicit notice (fails when REQUIRE_PREVIOUS_RELEASE_TAG=true).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="${1:?report dir}"
cd "$CI_ROOT"
TAG="$(previous_release_tag)"
if [ -z "$TAG" ]; then
  note_no_previous_tag "$OUT"
  exit
fi
printf '{"status":"present","tag":"%s","commit":"%s"}\n' "$TAG" "$(git rev-parse "$TAG^{commit}")" >"$OUT/previous-release.json"
J="$OUT/junit-n-minus-1"
mkdir -p "$J"
DB="ehr_nm1_$$"
db_create "$DB"
prepare_previous_tree "$TAG"
echo "== upgrade path: $TAG then candidate"
migrate_from_previous "$TAG" "$DB" 2>&1 | tee "$OUT/upgrade-path.txt"
db_drop "$DB"

echo "== N-1: $TAG suites against the candidate schema"
rm -rf "$PREV_TREE/db/migrations" "$PREV_TREE/db/roles"
cp -a "$CI_ROOT/db/migrations" "$PREV_TREE/db/migrations"
cp -a "$CI_ROOT/db/roles" "$PREV_TREE/db/roles"
suites=()
rc=0
for s in db-foundation kernel api worker; do
  # A suite the previous release did not have is not an N-1 suite; a suite it had must run and pass.
  if [ -z "$(suite_files "$PREV_TREE" "$s")" ]; then
    echo "previous release $TAG has no $s database suite; not part of N-1"
    continue
  fi
  suites+=("$s")
  run_db_suite "$PREV_TREE" "$s" "$J" "$OUT/n-minus-1-$s.txt" || rc=1
done
[ "${#suites[@]}" -gt 0 ] || { echo "::error::previous release $TAG has no database suite to run (empty N-1 suite)"; exit 1; }
node "$MC_DIR/check-junit.mjs" "$J" "${suites[@]}" || rc=1
[ "$rc" -eq 0 ] || { echo "::error::N-1: the previous release ($TAG) does not pass against the candidate schema"; exit 1; }
echo "N-1 passed against $TAG"
