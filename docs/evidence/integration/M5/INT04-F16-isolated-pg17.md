# INT04-F16: isolated PostgreSQL 17 for integration-db runs

Status: provisioned and verified (script below). No credentials are stored in the repository.

## What was delivered
`scripts/ci/ephemeral-pg17.sh` starts a private PostgreSQL 17.11 server for one run. It needs no root and no container, because neither is available to this agent user (no `docker`, no system `postgres`).
- Binaries come from the npm package `embedded-postgres@17.11.0-beta.19`, which is pinned and installed into the run's own state directory.
- Each run uses a free random port, bound to 127.0.0.1 only, and a random superuser password.
- State and the password file are created with mode 0700/0600 under `$TMPDIR/ehr-epg-<user>-<run id>`, which is outside the repository. Set `EPG_RUN_ID` for a stable name per run. It defaults to `PAPERCLIP_RUN_ID`, then to `$PPID`.
- `start` prints `export` lines for `EHR_TEST_ADMIN_URL`, which holds the credential. Do not log it or paste it into tasks.

## Usage on the integrator's run
```
export EPG_RUN_ID=<unique per run>
eval "$(scripts/ci/ephemeral-pg17.sh start)"     # server up, EHR_TEST_ADMIN_URL exported
# create/migrate a database as in db/tools/migrate.mjs bootstrap + migrate, then run the integration-db suite
scripts/ci/ephemeral-pg17.sh stop                # stop and delete data + password file
```
The integrator must not point the suite at the shared `db:5432` server (`DATABASE_URL`), which caused INT04-F16. Every run gets its own server, so concurrent runs cannot slow each other. `fsync` is off, so the server is for tests only, never for data worth keeping.

## Checks run
- `start`, connect over TCP with the generated URL, `select version()` returned `PostgreSQL 17.11 on x86_64-pc-linux-gnu`, `create database` succeeded, and `stop` removed the data directory. A throwaway run was used and its state deleted.
- The integration-db suite itself was **not** run here. This worktree has none of the application code (the repository on this branch holds only docs), and the HEAAA-139 integration worktree must not be touched. The integrator should run the suite with the steps above.

## Limits
- Needs outbound access to registry.npmjs.org on first start (about 2 s, 17 packages). Set `EPG_STATE` to a directory that already holds `node_modules` to reuse it offline.
- No missing permission was found, so there is no blocker.
