# Evidence index

Evidence folders are kept byte-identical (hashes are recorded) and are excluded from formatting.

**PRD requirement trace on the final dev head (HEAAA-955):** `prd-trace/PRD-TRACE-MATRIX.md` (requirement, merged code, case, last recorded result, gaps) and `prd-trace/head-run/` (checks executed on the head).

**Newest evidence (R2, candidate `cdc388d`, CI run 42822981701):**

- QA execution: `qa-execution/r2-cdc388d/` (see `QA-REPORT.md`).
- Quality-security: `../quality-security/R2/` (see `RESULT.md`).
- Local development workflow: `../RUN-GUIDE.md`.

`integration/R1/round3/INT-05-RESULT-r3.md` predates the candidate. It lists container scan, contract, e2e, Lighthouse and N-1 as not run. Those are covered by the R2 evidence above.
