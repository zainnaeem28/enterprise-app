# Requests outside `apps/cms/**` (for the Orchestrator / Integrator)

FE-16's allowed path is `apps/cms/**`. These changes are needed for the branch to install and run in CI; they were
**prepared and exercised locally but not committed to the root files**.

1. **Lockfile and workspace settings** — `root-changes.request.patch` (applies cleanly to this branch's base).
   - `pnpm-lock.yaml`: new `apps/cms` importer. `pnpm install --frozen-lockfile` fails on this branch until applied.
   - `pnpm-workspace.yaml`:
     - `allowBuilds: { esbuild: false }`. Payload's `drizzle-kit` pulls three esbuild versions whose install scripts pnpm
       blocks, and the install otherwise exits non-zero with `ERR_PNPM_IGNORED_BUILDS`. Binaries are delivered as optional
       packages, so the script is not needed.
     - `overrides` for `dompurify >=3.4.17`, `happy-dom >=21.0.4`, `esbuild <0.25.0 → >=0.25.0`. Without them
       `pnpm audit --prod --filter @ehr/cms` reports 9 advisories (1 critical, 3 high, 1 moderate, 4 low; all transitive via
       Payload). With them: 1 low remains (`deepmerge` GHSA-gcqx-w48m-w2h4, no patched version exists; Payload's own dependency).
   - The lock diff is large because pnpm re-resolved peer-dependency suffixes for other importers when `apps/cms` was added; the
     Integrator should regenerate and re-run the site/patient/staff checks on the combined lockfile rather than trust this diff.
2. **`docs/DEPENDENCIES.md`** — add a row per new top-level dependency (all exact pins; `pnpm licenses` read from installed manifests):

   | Package                                                                          | Version | Licence | Reason                                                                                                                                                                                |
   | -------------------------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | payload, @payloadcms/next, @payloadcms/db-postgres, @payloadcms/richtext-lexical | 3.93.0  | MIT     | C-19 / UX-O-02: off-the-shelf self-hosted headless CMS and editor (ARCHITECTURE 7). No paid licence or paid plan is used; Google sign-in is our own OIDC code, not a vendor SSO tier. |
   | next                                                                             | 16.4.5  | MIT     | Required by Payload 3's admin (peer range `>=16.3.3 <17`). Only `apps/cms`; the brand site stays on Vite SSR.                                                                         |
   | graphql                                                                          | 16.15.0 | MIT     | Payload peer dependency (`^16.8.1`); the GraphQL endpoint is disabled.                                                                                                                |
   | jose                                                                             | 6.2.14  | MIT     | ID-token and session JWT verification. 6.2.15/6.2.16 were under 10 days old and blocked by the release-age policy.                                                                    |
   | react, react-dom                                                                 | 19.3.1  | MIT     | Same pin as `apps/site`.                                                                                                                                                              |
   | vitest (dev)                                                                     | 5.1.0   | MIT     | Same pin as `apps/site`.                                                                                                                                                              |

   Licence notes for the owner/Architect: the production tree has one `LGPL-3.0-or-later` package (`@img/sharp-libvips-linux-x64`,
   prebuilt libvips, dynamically linked through `sharp`, an optional dependency of `next`), plus `CC-BY-4.0` data
   (`caniuse-lite`), `Python-2.0` (`argparse`), `WTFPL` (`truncate-utf8-bytes`), `BlueOak-1.0.0` (`sax`). If the DELIVERY-PLAN section 9 licence
   policy denies LGPL, `sharp` must be excluded for `apps/cms` (the CMS has no media collection and does not need image processing).

3. **CI** — a job for `apps/cms` (typecheck, `test`, and `test:db` against the existing PostgreSQL service with a `cms`-named role
   and a throwaway database) is not wired; `.github/**` is outside FE-16's paths. Root `eslint .` also lints `apps/cms/.next`
   in a developer tree; add `**/.next/**` to the ignores in `eslint.config.mjs` (a clean CI checkout is unaffected).
4. **Brand site integration** (`apps/site`, FE-15's paths) — implement `ContentSource` from the CMS content API and a `/preview`
   route that calls `verifyPreviewToken` (`apps/cms/src/admin/preview.ts`) with the shared `CMS_PREVIEW_SECRET`. Not done here.
5. **Deploy** (`deploy-marketing`) — `cms.` host, WAF, optional IP allow-list, CMS-only database and role, secret delivery, container image,
   and the Workspace-side OAuth client restricted to the marketing group. The CMS only enforces its own start-up guards.
