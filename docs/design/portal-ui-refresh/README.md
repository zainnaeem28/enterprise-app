# Portal UI refresh

Originally developed on `design/portal-ui-refresh` from `76975c2`. Integrated into `dev` on 2026-11-12, preserving the newer functionality through `6e4fe0f`.

The public website, patient portal, doctor and reception workspace, administrator tools, and CMS share a calm teal/slate visual system. Existing clinical, consent, authentication and authorisation behavior stays authoritative.

## Changes

- Shared typography, colour tokens, iconography, buttons, fields, cards, tables, dialogs, empty states, booking steps and schedules. Portal accents and the administrator realm banner remain distinct; colour is accompanied by text.
- Public homepage, service cards, care journey, responsive navigation, footer and cookie notice. Service and organisation facts still come from the API/CMS.
- Patient navigation and task dashboard linking to existing booking, appointment, profile and privacy pages. No fabricated appointment counts or health data.
- Staff desktop sidebar, mobile navigation, sign-in layout, schedule counts computed from loaded visits, and shared clinical/reception/admin page treatments. Role-based navigation is unchanged.
- CMS light/dark theme, sign-in card, navigation, forms and tables through its existing custom stylesheet.
- Local portability fixes carried from setup: renamed `Alerts.tsx` to `AlertsScreen.tsx` to avoid macOS case-insensitive resolution; corrected the worker's API module URL for project paths containing spaces.

## Original redesign validation

- Full workspace build and lint (existing test-fixture warnings only).
- 916 unit/component tests passed across shared UI (177), app shell (89), patient (200), staff (282), website (76) and CMS (92). Existing contrast and component accessibility checks included.
- Real local browser review: 23 pages at 1440px and 390px, 46 viewport/page combinations; no WCAG A/AA axe violations and no document overflow detected.
- Patient Playwright journey: 3/3 tests passed, including sign-in, sign-out and refusal states.
- Administrator real-stack browser workflow: 7/7 steps passed, including security-key sign-in, configuration persistence, audit viewer and access-review decisions.
- Screenshots and detailed browser results are in `reports/ui-refresh/` locally. Representative screenshots accompany this document.

These checks cover the exercised pages and states, not a complete manual accessibility audit. CMS sign-in was visually checked; authenticated CMS editing still needs configured Google credentials. External-provider features retain their existing configuration requirements.

## Preview

While the local demo is running, open `http://localhost:8088` and select Patient, Doctor or Reception. Website: `http://localhost:8080`. CMS: `http://localhost:3100/admin`. Local HTTPS certificates require browser acceptance. Only synthetic data is used.

## Screenshots

| Surface | Preview |
| --- | --- |
| Website | [Homepage](website.png) |
| Patient | [Dashboard](patient.png) |
| Doctor | [Schedule](doctor.png) |
| Reception | [Arrivals](reception.png) |
| Administrator | [Audit viewer](administrator.png) |
| CMS | [Sign-in](cms.png) |
| Mobile | [Staff schedule](mobile.png) |

## Integration with current dev (2026-11-12)

The merge keeps configurable organisation branding, patient-banner/photo binding, guardian permissions, scoped family invitations, deletion statements, clinician licensing and the latest messaging/telehealth wording. Patient navigation now includes Family & access; the dashboard also links to family management and notification preferences.

Additional styling covers:

- Family/access lists and scope controls, invitation entry and confirmation.
- Privacy request history and post-deletion statements.
- Staff parent/guardian access forms and revocation lists.
- Administrator clinician licensing search, state editor and operating-state reference.

Browser review used controlled synthetic API responses for these new screens: seven screens at 1440px and 390px, with no detected axe A/AA violations or document overflow. This checks UI behavior and layout, not backend completion. Invitation confirmation was exercised. Results are in `reports/design-integration/` locally. New previews: [family](family-mobile.png), [invitation](invitation-mobile.png), [guardian access](guardian-mobile.png), [licensing](licensing.png).

Integration validation: workspace build, typecheck, module-boundary check and lint passed (30 existing fixture warnings). The six UI suites passed 947 tests: UI 180, app shell 89, patient 212, staff 298, site 76 and CMS 92. One lazy-route assertion timed out in the parallel run; the complete staff suite passed when rerun alone without changing that test. Patient browser journey: 3/3 tests passed. The new-screen browser checks use contract responses; the earlier real-stack admin evidence above predates this merge.

## Adding screens

Use the existing portal shell and components from `@ehr/ui`; keep colours, borders, spacing and focus states based on `packages/ui/src/tokens.css`. Add feature CSS only for layouts the shared components do not cover. Patient account screens use `profile.css`; staff features inherit `portal.css` and use scoped feature classes. CMS uses its existing custom stylesheet.

Register new routes in the relevant route map and authorised navigation. Keep configured brand names via `resolveBrandName`, respect feature flags, and preserve the administrator realm banner. Check loading, empty, validation, refusal and success states. Review a real rendered screen at desktop and phone widths, keyboard navigation and axe checks before merging. Shared styling applies automatically, but each new workflow still needs its own review.
