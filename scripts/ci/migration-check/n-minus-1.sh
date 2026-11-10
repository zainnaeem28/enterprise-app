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
# The catalog contract is the candidate's (HEAAA-722 D2): the previous release's tools would re-assert the previous catalog.
for f in catalog-lists.mjs catalog-check.mjs; do
  [ -f "$CI_ROOT/db/tools/$f" ] && cp -a "$CI_ROOT/db/tools/$f" "$PREV_TREE/db/tools/$f"
done
SKIPS="$MC_DIR/n-minus-1-skips.tsv"
SKIP_REPORT="$OUT/n-minus-1-skipped.txt"
: >"$SKIP_REPORT"
# skip_regex <suite>: regex of the listed tests for the suite; an entry absent from the previous tree is ignored with a notice.
skip_regex() {
  local suite="$1" sfx name reason files re=""
  while IFS=$'\t' read -r sfx name reason; do
    case "$sfx" in ''|'#'*) continue ;; esac
    [ "$sfx" = "$suite" ] || continue
    mapfile -t files < <(suite_files "$PREV_TREE" "$suite")
    if ! (cd "$PREV_TREE" && grep -qF -- "$name" "${files[@]}"); then
      echo "::notice::N-1 skip list entry not present in $TAG, ignored: $name" >&2
      continue
    fi
    echo "::notice::N-1 SKIPPED (not a pass) [$suite] $name -- $reason" >&2
    printf '%s\t%s\t%s\n' "$suite" "$name" "$reason" >>"$SKIP_REPORT"
    re="${re:+$re|}$(node -e 'process.stdout.write("^"+process.argv[1].replace(/[.*+?^${}()|[\]\\\/]/g,"\\$&")+"$")' "$name")"
  done <"$SKIPS"
  printf '%s' "$re"
}
suites=()
rc=0
for s in db-foundation kernel api worker; do
  # A suite the previous release did not have is not an N-1 suite; a suite it had must run and pass.
  if [ -z "$(suite_files "$PREV_TREE" "$s")" ]; then
    echo "previous release $TAG has no $s database suite; not part of N-1"
    continue
  fi
  suites+=("$s")
  run_db_suite "$PREV_TREE" "$s" "$J" "$OUT/n-minus-1-$s.txt" "$(skip_regex "$s")" || rc=1
done
[ "${#suites[@]}" -gt 0 ] || { echo "::error::previous release $TAG has no database suite to run (empty N-1 suite)"; exit 1; }
node "$MC_DIR/check-junit.mjs" "$J" "${suites[@]}" || rc=1
[ "$rc" -eq 0 ] || { echo "::error::N-1: the previous release ($TAG) does not pass against the candidate schema"; exit 1; }
echo "N-1 passed against $TAG"
[ ! -s "$SKIP_REPORT" ] || echo "::notice::N-1 passed with $(wc -l <"$SKIP_REPORT") listed test(s) skipped (not a pass); see n-minus-1-skipped.txt"
