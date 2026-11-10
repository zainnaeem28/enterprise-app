# Shared helpers for the database jobs (F-09, HEAAA-79). Source this file; do not execute it.
# shellcheck shell=bash
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

MC_DIR="$CI_ROOT/scripts/ci/migration-check"
# The throwaway PostgreSQL 17 service of the job (trust authentication, synthetic data, loopback only).
export EHR_TEST_ADMIN_URL="${EHR_TEST_ADMIN_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
# Previous-release tags are r<release_number> (the portal prefix of X-Client-Release, DEVOPS-PLAN 6.2).
RELEASE_TAG_GLOB="${RELEASE_TAG_GLOB:-r[0-9]*}"
PREV_TREE="${PREV_TREE:-${RUNNER_TEMP:-/tmp}/previous-release-tree}"

# db_url <role> <database>: connection string for a role on the job's server.
db_url() { node "$MC_DIR/db-admin.mjs" url "$1" "$2"; }
db_create() { node "$MC_DIR/db-admin.mjs" create "$1"; }
db_drop() { node "$MC_DIR/db-admin.mjs" drop "$1"; }

# previous_release_tag: print the newest r<N> tag that is an ancestor of HEAD and not HEAD itself; nothing if none.
previous_release_tag() {
  local head tag
  head="$(git -C "$CI_ROOT" rev-parse HEAD)"
  while read -r tag; do
    [ -n "$tag" ] || continue
    [ "$(git -C "$CI_ROOT" rev-parse "$tag^{commit}")" = "$head" ] && continue
    git -C "$CI_ROOT" merge-base --is-ancestor "$tag" HEAD || continue
    echo "$tag"
    return 0
  done < <(git -C "$CI_ROOT" tag --list "$RELEASE_TAG_GLOB" --sort=-version:refname)
  return 0
}

# fail_if_tag_required: used when there is no previous release tag.
note_no_previous_tag() {
  local out="$1"
  printf '{"status":"none","reason":"no tag matching %s is an ancestor of HEAD (first release)"}\n' "$RELEASE_TAG_GLOB" >"$out/previous-release.json"
  if [ "${REQUIRE_PREVIOUS_RELEASE_TAG:-false}" = "true" ]; then
    echo "::error::REQUIRE_PREVIOUS_RELEASE_TAG is true but no previous release tag ($RELEASE_TAG_GLOB) exists" >&2
    return 1
  fi
  echo "::notice::no previous release tag ($RELEASE_TAG_GLOB): the upgrade path and the N-1 suite did NOT run (first release). Not a pass of those checks."
}

# prepare_previous_tree <tag>: worktree of the tag with its own frozen install and kernel build.
prepare_previous_tree() {
  local tag="$1"
  git -C "$CI_ROOT" worktree remove --force "$PREV_TREE" 2>/dev/null || true
  rm -rf "$PREV_TREE"
  git -C "$CI_ROOT" worktree add --detach "$PREV_TREE" "$tag" >/dev/null
  [ -f "$PREV_TREE/db/tools/migrate.mjs" ] || {
    echo "::error::release $tag has no db/tools/migrate.mjs; cannot migrate from it" >&2
    return 1
  }
  (cd "$PREV_TREE" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
}

# migrate_from_previous <tag> <database>: previous release's roles and migrations, then the candidate's.
migrate_from_previous() {
  local tag="$1" db="$2"
  EHR_DB_ADMIN_URL="$(db_url "$(node "$MC_DIR/db-admin.mjs" admin-user)" "$db")" node "$PREV_TREE/db/tools/migrate.mjs" bootstrap
  EHR_DB_MIGRATE_URL="$(db_url app_owner "$db")" node "$PREV_TREE/db/tools/migrate.mjs" migrate
  echo "== candidate migrations on top of $tag"
  EHR_DB_ADMIN_URL="$(db_url "$(node "$MC_DIR/db-admin.mjs" admin-user)" "$db")" node "$CI_ROOT/db/tools/migrate.mjs" bootstrap
  EHR_DB_MIGRATE_URL="$(db_url app_owner "$db")" node "$CI_ROOT/db/tools/migrate.mjs" migrate
}

# suite_files <tree> <suite>: the database-backed test files of a suite, one per line (relative to the tree), sorted.
suite_files() {
  local tree="$1"
  case "$2" in
    # db/tests/*.test.mjs: standalone real-database files (referral-accept-scope: definer pins and the patient_scope_owner USAGE-relaxation checks).
    db-foundation)
      [ -f "$tree/db/tools/db-test.mjs" ] && echo db/tools/db-test.mjs
      (cd "$tree" && find db/tests -maxdepth 1 -name '*.test.mjs' 2>/dev/null | sort)
      ;;
    kernel) (cd "$tree" && find packages/kernel/dist -name '*.dbtest.js' 2>/dev/null | sort) ;;
    api) (cd "$tree" && find apps/api/dist -name '*.dbtest.js' 2>/dev/null | sort) ;;
    worker) (cd "$tree" && find apps/worker/dist -name '*.dbtest.js' 2>/dev/null | sort) ;;
    *) echo "unknown suite $2" >&2; return 1 ;;
  esac
}

# run_db_suite <tree> <suite> <junit-dir> <log> [skip-regex]: node:test over the suite's files with spec + JUnit reporters.
run_db_suite() {
  local tree="$1" s="$2" junit="$3" log="$4" skip="${5:-}" files extra=()
  [ -z "$skip" ] || extra=(--test-skip-pattern "$skip")
  mapfile -t files < <(suite_files "$tree" "$s")
  [ "${#files[@]}" -gt 0 ] || { echo "::error::suite $s: no database test files found in $tree (an empty suite fails)" >&2; return 1; }
  echo "== suite $s (${#files[@]} file(s), $tree)"
  (cd "$tree" && node --test \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=junit --test-reporter-destination="$junit/$s.xml" \
    "${extra[@]}" "${files[@]}") 2>&1 | tee "$log"
}
