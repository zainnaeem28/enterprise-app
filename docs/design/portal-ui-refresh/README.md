# Portal UI refresh

Branch: `design/portal-ui-refresh`, based on `dev` at `76975c2`.

The public website, patient portal, doctor and reception workspace, administrator tools, and CMS share a calm teal/slate visual system. Existing clinical, consent, authentication and authorisation behavior stays authoritative.

## Changes

- Shared typography, colour tokens, iconography, buttons, fields, cards, tables, dialogs, empty states, booking steps and schedules. Portal accents and the administrator realm banner remain distinct; colour is accompanied by text.
- Public homepage, service cards, care journey, responsive navigation, footer and cookie notice. Service and organisation facts still come from the API/CMS.
- Patient navigation and task dashboard linking to existing booking, appointment, profile and privacy pages. No fabricated appointment counts or health data.
- Staff desktop sidebar, mobile navigation, sign-in layout, schedule counts computed from loaded visits, and shared clinical/reception/admin page treatments. Role-based navigation is unchanged.
- CMS light/dark theme, sign-in card, navigation, forms and tables through its existing custom stylesheet.
- Local portability fixes carried from setup: renamed `Alerts.tsx` to `AlertsScreen.tsx` to avoid macOS case-insensitive resolution; corrected the worker's API module URL for project paths containing spaces.

## Validation

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
