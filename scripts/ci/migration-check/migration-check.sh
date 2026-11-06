#!/usr/bin/env bash
# migration-check job (DEVOPS-PLAN 5.2). On a PostgreSQL 17 server (EHR_TEST_ADMIN_URL):
#   1. lint db/migrations (DML ban, expand/contract);
#   2. migrate from EMPTY, then run every catalog rule (db/tools/catalog-check.mjs + extra-checks.mjs);
#   3. migrate from the PREVIOUS RELEASE TAG (its own tooling and migrations, then the candidate's), run the rules again;
#   4. secret-reference lint over tracked configuration (RDS master user).
# Raw reports: reports/migration-check/. Exit non-zero on any violation. Needs `pnpm build` done.
# MIGRATION_CHECK_SEED_SQL (seeded-violation proof only): SQL run as the administrator after the empty-path migration.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$(report_dir migration-check)"
cd "$CI_ROOT"
ADMIN_USER="$(node "$MC_DIR/db-admin.mjs" admin-user)"
failed=0
step() {
  local name="$1"
  shift
  echo "== $name"
  if "$@"; then echo "ok   $name"; else
    echo "::error::FAILED $name"
    failed=1
  fi
}

lint_migrations() { node db/tools/check-migrations.mjs 2>&1 | tee "$OUT/lint.txt"; }

migrate_empty() {
  EHR_DB_ADMIN_URL="$(db_url "$ADMIN_USER" "$1")" node db/tools/migrate.mjs bootstrap &&
    EHR_DB_MIGRATE_URL="$(db_url app_owner "$1")" node db/tools/migrate.mjs migrate 2>&1 | tee "$OUT/migrate-empty.txt"
}

apply_seed_sql() {
  node -e '
    const pg = require("pg"), fs = require("fs");
    (async () => {
      const c = new pg.Client({ connectionString: process.argv[1] });
      await c.connect();
      await c.query(fs.readFileSync(process.argv[2], "utf8"));
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });' \
    "$(db_url "$ADMIN_USER" "$1")" "$MIGRATION_CHECK_SEED_SQL"
}

run_rules() { # run_rules <label> <database>
  local label="$1" admin
  admin="$(db_url "$ADMIN_USER" "$2")"
  EHR_DB_ADMIN_URL="$admin" node db/tools/catalog-check.mjs >"$OUT/catalog-$label.json" 2>"$OUT/catalog-$label.err" || true
  [ -s "$OUT/catalog-$label.json" ] || { cat "$OUT/catalog-$label.err" >&2; return 1; }
  EHR_DB_ADMIN_URL="$admin" node "$MC_DIR/extra-checks.mjs" >"$OUT/extra-$label.json" 2>"$OUT/extra-$label.err" || true
  [ -s "$OUT/extra-$label.json" ] || { cat "$OUT/extra-$label.err" >&2; return 1; }
  node "$MC_DIR/verify-catalog.mjs" "$OUT/catalog-$label.json" "$OUT/extra-$label.json" 2>&1 | tee "$OUT/verify-$label.txt"
}

migrate_from_tag() { migrate_from_previous "$1" "$2" 2>&1 | tee "$OUT/migrate-from-tag.txt"; }
config_lint() { node "$MC_DIR/lint-config-secrets.mjs" 2>&1 | tee "$OUT/config-secrets.txt"; }

step "migration lint (DML ban, expand/contract)" lint_migrations

DB_A="ehr_mc_empty_$$"
db_create "$DB_A"
step "migrate from empty" migrate_empty "$DB_A"
if [ -n "${MIGRATION_CHECK_SEED_SQL:-}" ]; then
  echo "seeded violation SQL applied (proof run only)"
  step "apply seeded SQL" apply_seed_sql "$DB_A"
fi
step "catalog rules after migrating from empty" run_rules empty "$DB_A"

TAG="$(previous_release_tag)"
if [ -z "$TAG" ]; then
  step "no previous release tag, and none required" note_no_previous_tag "$OUT"
else
  printf '{"status":"present","tag":"%s","commit":"%s"}\n' "$TAG" "$(git rev-parse "$TAG^{commit}")" >"$OUT/previous-release.json"
  DB_B="ehr_mc_prev_$$"
  db_create "$DB_B"
  step "prepare previous release tree ($TAG)" prepare_previous_tree "$TAG"
  step "migrate from $TAG, then the candidate" migrate_from_tag "$TAG" "$DB_B"
  step "catalog rules after migrating from $TAG" run_rules from-tag "$DB_B"
  db_drop "$DB_B"
fi
db_drop "$DB_A"

step "secret-reference lint (RDS master user)" config_lint

{ echo "node $(node -v)"; echo "server $(node -e 'const pg=require("pg");(async()=>{const c=new pg.Client({connectionString:process.argv[1]});await c.connect();console.log((await c.query("select version() v")).rows[0].v);await c.end()})()' "$EHR_TEST_ADMIN_URL")"; } >"$OUT/versions.txt"
git rev-parse HEAD >"$OUT/candidate-commit.txt"
[ "$failed" -eq 0 ] || { echo "::error::migration-check FAILED"; exit 1; }
echo "migration-check passed"
