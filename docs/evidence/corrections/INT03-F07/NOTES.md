# INT03-F07 correction

Base 1cd3cbc. `prettier --write` on the five listed files only.
- JSON (3 files): parsed-and-restringified content identical before/after (hashes of minified JSON equal).
- MANIFEST.md (2 files): only table separator row widened; `diff -w` shows 1 line each. No file hashes in these manifests refer to the reformatted files (they only mention `playwright-report.json` by name; no sha256 listed for it or for MANIFEST).
- `pnpm run format:check`, `lint`, `test:boundary`: exit 0 (see txt files). `typecheck` and `build` exit 1 with the same apps/api TS errors as INT-03 r1 raw (other findings, out of scope here).
