# INT03-F02 correction evidence
Base: 1cd3cbc (candidate c48db50). Node v24.22.2, pnpm 12.16.1. Synthetic data only.

Changes: (a) composition.ts passes `limiter: new MemoryRateLimiter(1)` to createFlowControllers; (b) identity-label.dbtest.ts requestConsent passes language 'en'; (c) new `modules/organisation/consent-template-port.ts` `isConsentTemplatePublished` filters on `language`, used by composition.ts and the identical closure in worker-ports.ts (same bug; outside the listed paths, flagged for the reviewer); no other behaviour changes.

| Command | Result | Raw |
| --- | --- | --- |
| pnpm install --frozen-lockfile | exit 0 | raw/install.txt |
| pnpm run lint | exit 0 | raw/lint.txt |
| pnpm run typecheck | exit 0 | raw/typecheck.txt |
| pnpm run build | exit 0 | raw/build.txt |
| pnpm run test:boundary | exit 0 | raw/test:boundary.txt |
| pnpm run format:check | exit 1: 5 pre-existing files under apps/staff/src/features/*/evidence (MD/JSON), untouched by this change | raw/format:check.txt |
| organisation.dbtest.js (real DB) | language test PASS (en published -> en true, fr false, v2 false); suite fails on the catalog check (M-5-patient-guard/M-5-definer) = INT03-F03, pre-existing, not this ticket | raw/organisation-dbtest.txt |

Not run: identity-label.dbtest (compiles, arity fixed; not executed here).
