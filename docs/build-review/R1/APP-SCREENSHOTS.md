# APP-SCREENSHOTS — manifest (Release 1 build, BUILD_REVIEW)

Every file is a real PNG captured from the running application (real API, worker, PostgreSQL 17.11 and built staff app, Chromium 156.0.8078.4) by `scripts/ci/admin-stack.mjs` in INT-05 round 4 on candidate `af27830`. Synthetic data only. None is a mockup. Files are committed at `3cb45ed` under `docs/evidence/integration/R1/round4/shots/` and are presented as attachments of the gate task.

## A. Candidate screenshots (administrator realm, candidate af27830)

| # | File | Shows | sha256 |
| --- | --- | --- | --- |
| 01 | `01-admin-sign-in-form.png` | admin sign in form | `5cf9f850420872960b8559d40809a949d62e9b9798734a93ad68ab14b1ed8903` |
| 02 | `02-signed-in-landing.png` | signed in landing | `8ac59585adfac23cadcd61ae9103e913cd5d47af3eac85d3c2b9b492fdd319bb` |
| 03 | `03-services-form-filled.png` | services form filled | `30d43a1a63757faba457a954dbc60122ba748e449bf453858b5877568bcbf755` |
| 04 | `04-services-saved.png` | services saved | `dd75b677c2d201ac9120932ca0ca5f41c775f1df687810967483318179ca889b` |
| 05 | `05-services-after-reload.png` | services after reload | `bfb26a044d1940aed3c22508fa58d7d13d2a279aedc91d8253801e37d0cce4ac` |
| 06 | `06-audit-viewer-results.png` | audit viewer results | `363fa5c9b2a26fc33be1277ff9b9050a99c5b4699f4e3fc6d21f5b36c01c1e25` |
| 07 | `07-break-the-glass-pending-list.png` | break the glass pending list | `58b4d2a6555be80d3c176ff7a7b29ed5b86b798c986397b1194f881ca271806a` |
| 08 | `08-break-the-glass-decision-form.png` | break the glass decision form | `87d50192a877515a6d876627fce78b542391d56ce1a5dad13486b3aad1354098` |
| 09 | `09-break-the-glass-decision-recorded.png` | break the glass decision recorded | `6303df56643ae54baef95406c964c54acaf101ec8337ccfa491a4acd0c02a7f4` |
| 10 | `10-break-the-glass-justified-list.png` | break the glass justified list | `9c20279b37d2623f8fb272bf2b93de8f7796c68d2d8584a8e8a5cb61a0a784ba` |

Run result for these shots (`shots/summary.json`): 7 of 7 steps ok: enrol admin with fixture key, security-key sign-in, create a service and see it saved, still there after reload, audit viewer shows entries, record a break-the-glass decision, decision persisted under Justified after reload.

## B. Ticket-level screenshots committed earlier (NOT re-captured on the candidate)

The patient-portal tickets committed their own Playwright captures. They were produced on the ticket's reviewed revision, before integration; they are evidence for that ticket review, not for `af27830`.

| Area | Location (at `3cb45ed`) | Count |
| --- | --- | --- |
| booking | `apps/patient/src/features/booking/evidence/screenshots/` | 22 |
| previsit | `apps/patient/src/features/previsit/evidence/screens/` | 60 |

## C. Not captured (gap, stated plainly)

No candidate screenshots exist for: doctor portal (schedule, chart, note editor), front-desk portal, patient portal on the integrated candidate (its 3-test sign-in journey passed but committed no images; section B images pre-date integration), marketing site, CMS editor, telehealth. The environment has no Docker daemon and no deployed stack. Capturing them belongs to QA execution (HEAAA-29) against the release candidate. The reviewer should treat the candidate-level visual evidence as the administrator path only.
