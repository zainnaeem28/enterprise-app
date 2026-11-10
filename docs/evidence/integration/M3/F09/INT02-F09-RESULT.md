# INT02-F09 — documents TC-DOC-05 (HEAAA-196)

Base: fbef9a1 (round 2 failed candidate). PostgreSQL 17. Change: `apps/api/src/modules/documents/documents.dbtest.ts` only; no service change.

## Cause
Not shared state and not file order (each dbtest file creates its own database; the documents tests share no clock, key or fixtures with other files).
TC-DOC-05 read `now` once, before the download URL was minted, and used it for the 60-second GET bound. `verify` compares whole seconds
(`floor(now) > exp`, `exp = floor(mint time) + 60`), so `now + 61 s` is refused only if `now` and the mint fall in the same wall-clock second.
Any run in which a second boundary falls between the two (a loaded full run, 4 parallel files) fails "a download URL lives 60 seconds";
an idle single-file run usually passes. It is a timing flake that correlates with the full run, not a cross-patient read defect.

Deterministic reproduction (temporary sleep to the next second boundary before the download request): fails with
`AssertionError: a download URL lives 60 seconds (true !== false)`; the same delay passes with the fix. The temporary sleep is not committed.

## Fix
GET-URL checks use a reading (`gnow`) taken after the URL exists. The security assertions are unchanged and no retry or reordering was added.

Second latent flake found in the same file (observed once in a full run): the PHI-in-URL check matched a bare `1980` against random hex
(~0.14% per run measured). It now matches the date of birth `1980-05-17` with or without hyphens. Names and IDs checks unchanged.

## Checks (raw in this folder)
- documents dbtest alone: 21/21 (documents-dbtest-alone.txt)
- full api dbtest run: see api-suite-run.txt; documents file result listed there. Other files still fail from INT02-F07 (alerts) and F08 (merge concurrency), outside this task.
- typecheck, eslint (documents), prettier, api unit tests 52/52: pass
