# QS-02 dependency advisories (HEAAA-639)

Scan: `pnpm audit` on the integrated revision 3c1dbd3 (before) and on the QS-02 correction commit (after).

| Package | Advisory | Before | Action | After |
| --- | --- | --- | --- | --- |
| `minimatch` | GHSA-g3hv-75wg-m249 (moderate, `>=7.0.0 <11.0.1`) | 10.2.6 (eslint, typescript-eslint) | `pnpm-workspace.yaml` override `minimatch@>=7.0.0 <11.0.1: '>=11.0.1'` | 11.x; lint passes. `minimatch@5.1.9` (openapi tooling) is outside the affected range. |
| `yaml` | GHSA-48c2-rrv3-qjmp (moderate, `>=2.0.0 <2.8.3`) | 2.8.1 | override `yaml@>=2.0.0 <2.8.3: '>=2.8.3'` | >=2.8.3. `yaml@1.10.3` (cosmiconfig, dev-only) is outside the affected range. |
| `deepmerge` | GHSA-gcqx-w48m-w2h4 (low, `>=4.2.0 <=4.3.1`, `mergeObject()` prototype poisoning) | 4.3.1 | **No fix exists (patched versions: none).** Disposition: accepted, no ignore entry needed. | 4.3.1 |

`deepmerge` disposition. Only reachable through `payload` (the CMS admin, `apps/cms`), a transitive dependency of the CMS admin
(`apps/cms`) used for configuration merging. Reachability from request input was not analysed here; the CMS is
behind the staff realm and the advisory is low severity.
Severity is low, below the OSV gate (HIGH/CRITICAL with a fix fails the scan, `osv/osv-scanner.toml`).
Owner: DevOps. Reviewer: Security Reviewer. Re-check when `payload` or `deepmerge` publishes a fix; remove this
entry then. `pnpm audit` after the change reports 1 low (this one), 0 moderate, 0 high, 0 critical.
