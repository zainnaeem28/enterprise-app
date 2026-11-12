# HEAAA-990 evidence (R5-F01 / QA982-F01)
Branch HEAAA-990-banner-photo, head 9a3bf142d45d2a386f9e6669c8b378ab6d147a07, tree 65c3f45d445d2c5ffb10b4ffffb83500ec6d422e, base origin/dev eb2b191f9a23c78119cc6d261278af13d4e81afc.
Change: `DocumentsService.photoUrl` (clean-photo 60 s signed URL, null when absent/unclean/invisible/unsignable; no extra audit, banner read is audited) wired as `photo` port in `createClinicalChart` (composition.ts). RLS applies (same tx).
Test: apps/api/test/chart-summary.dbtest.ts, production `buildComposition`+`createApp`: no photo -> no photoUrl; clean photo -> signed `exp=60` URL. Verified FAILING with the `photo` line removed (1 fail), passing with it.
Local runs on that head (real Postgres, throwaway embedded PG 18 at 127.0.0.1; the configured ehr-test-db host is unreachable from this sandbox):
- format:check pass; lint 0 errors (30 pre-existing warnings); typecheck pass
- api unit tests 366/366 pass; documents.dbtest 23/23; chart.dbtest 41/41; chart-summary.dbtest 2/2
Not run: submit_check.py, hosted CI (none, ruling B), browser/E2E. Independent review pending.
