# `@ehr/cms` — brand-site CMS (FE-16, C-19)

Self-hosted headless CMS in the **marketing account** (ARCHITECTURE 3.1 `cms`, 7 CMS row). Off-the-shelf editor
(**Payload 3**, MIT) per owner decision C-19 and UX-O-02: there is **no custom editor**. This package holds the
configuration only: collections, Google sign-in, login/preview branding and start-up guards.

| Concern                                                                                                                | Where                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Content (public, no PHI): pages (draft/publish/versions), banners, FAQs                                                | `src/collections/`                                                   |
| Marketing sign-in: separate Google Workspace OAuth client, PKCE + state + nonce, ID-token checks, marketing allow-list | `src/auth/google.ts`, `src/auth/endpoints.ts`                        |
| Session (custom Payload strategy; allow-list re-checked on every request)                                              | `src/auth/session.ts`                                                |
| No path or credential to the production database                                                                       | `src/lib/env.ts` (fails closed at start-up)                          |
| Site text and organisation facts for the brand site (globals `site-content`, `organisation`), idempotent reviewed seed | `src/globals/`, `src/seed/` (`pnpm --filter @ehr/cms seed`)          |
| Branding of the login and nav (placeholder tokens until C-16 supplies the brand)                                       | `src/admin/`                                                         |
| Preview link to the brand site (signed, short-lived)                                                                   | `src/admin/preview.ts`, `Pages.admin.preview`                        |
| Schema                                                                                                                 | `migrations/` (production runs `prodMigrations`; development pushes) |

## Commands

```sh
pnpm --filter @ehr/cms typecheck
pnpm --filter @ehr/cms test        # unit (vitest)
CMS_TEST_DATABASE_URL=postgres://cms_app:…@host:5432/cms_test pnpm --filter @ehr/cms test:db   # real Payload + PostgreSQL
pnpm --filter @ehr/cms build:next  # production build (needs the settings in .env.example)
```

`test:db` empties the target database first; point it only at a throwaway CMS-role database.

## Sign-in (what is and is not enforced here)

- Only Google Workspace accounts of `CMS_GOOGLE_HOSTED_DOMAIN` with a verified e-mail that is on `CMS_ALLOWED_EMAILS`.
- The "marketing group" is enforced twice: by the Workspace admin (the OAuth client is limited to the group, 2SV
  enforced by Workspace) and by the allow-list here. This code does **not** query Google group membership; that would
  need a service account with Directory API scope and is not part of the approved scope.
- There is no password login, no registration and no API-created users. Marketing identities get no role in the PHI portals.

## Known limits

- The brand site reads `site-content` and `organisation` through `ContentSource` (`apps/site/src/cms-content.ts`, HEAAA-799). It does not yet
  verify previews: the `/preview` route that calls `verifyPreviewToken` is not built. The `pages`, `banners` and `faqs` collections are not read by the site.
- The real Google consent screen, the marketing group, the `cms.` host/WAF/allow-list and the AWS network isolation
  are not exercised here (deploy-marketing, human Workspace setup).
- Root-level changes this package needs (lockfile, workspace overrides, dependency register, CI job) are in
  `REQUESTS.md`; they are outside `apps/cms/**`.
