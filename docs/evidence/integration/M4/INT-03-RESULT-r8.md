# INT-03 integration round 8 (HEAAA-379, closing bounded round)

Candidate: HEAAA-344 branch tip + merge of FE-15 `a1953ec` (HEAAA-129, independently reviewed PASS; was a listed INT-03 prerequisite but not yet on this branch). Candidate commit `raw/int03-r8/merged-tip/candidate-commit.txt` = `787d608`. The INT03-F15 bootstrap-retry fix (`0175fa8`, review HEAAA-378 PASS) was already on the tip. The merge was clean (adds `apps/site/**` and its lockfile importer only). Raw output: `raw/int03-r8/` (`pre-merge-tip-0175fa8/` = same gates on the tip before the merge; `merged-tip/` = after; `ui/` = journeys, screenshots, scripts, process logs). Journey stack: built API, worker and patient app run as separate processes against a throwaway migrated database; two fixture IdPs; synthetic data; SQL fixtures disclosed in `ui/setup.mjs` (clinic, services, patient, one staff principal holding the real seeded roles doctor + front_desk + care_coordinator) and `ui/enable-flag.mjs` (patient_messaging flag, D-5).

## Gates (both runs: exit 0 everywhere)
| Check | Pre-merge tip | Merged tip |
|---|---|---|
| install --frozen-lockfile, lint, format:check, typecheck, build, test:boundary | pass | pass |
| unit | pass | 1084 tests, 9 reports, none skipped/failed |
| integration-db (N-1 skipped) | **green on the first run**: 104 + 23 + 890 + 84 = 1101 tests | **green on the first run**, same counts |
| secrets (gitleaks, history + tree) | pass | pass |
| SAST (Semgrep) | pass | pass: 1182 files, 4 non-blocking MEDIUM (npm/pnpm settings) |
| deps (OSV) | pass | pass: 2 non-blocking (minimatch 6.9, yaml 4.3) |
INT03-F15 evidence: the worker boot suite passed first time in two further full runs (r7 had 4 intermittent failures). Two runs do not prove the race is gone; the diagnosis in `INT03-F15-diagnosis.md` stands.
N-1 migration: **not run, no release tag (recorded limitation, not failure).** Red-flag rule content: still BLOCKED on D-12a.

## Journeys (Chromium on the real stack; screenshots in `raw/int03-r8/ui/`)
| Journey | Result |
|---|---|
| Patient portal re-run (`patient-journey-run.txt`, `01`-`10`) | **PASS**: sign-in (incl. `GET /api/v1/me` 200 now), profile, notification preferences, messages list/new, privacy, appointments. |
| Privacy export request | **PASS for the request**: UI confirm dialog (`privacy-confirm-dialog.png`) -> `POST /api/v1/privacy-requests` 201 -> "Copy of my data / Received" (`09`, `10`). Not shown: identity check, approval, fulfilment, download. They are privacy-team actions and no screen for them exists in the build; the status stays Received. |
| Message send (`message-api-journey-run.txt`) | **PASS at the API, FAIL in the UI**: patient `POST /patients/{id}/threads` 201 and listed back; staff `POST /threads` 201, `POST /threads/{id}/messages` 201 and read back (note-to-self thread: only one staff principal in the fixture); patient on staff route 403. The patient UI says "Writing a new message is not available yet" (no compose form). The staff does NOT see the patient's thread: `GET /threads` is empty and `GET/POST /threads/{id}/messages` on it 404 (documented README O-2: staff routes list `kind='staff'` threads only). |
| Staff journeys, shipped build (`staff-shipped-*`) | **FAIL**: the shipped staff app is the F-06 placeholder (page "Staff portal / Server connection ... You are signed in"). Sign-in works at the API (staff realm, `hd` claim, roles returned), but every route (`/schedule`, `/tasks`, `/arrivals`, `/messages`) shows the same placeholder. `apps/staff/src/main.tsx` still mounts `App`; `src/app/entry.tsx` (which mounts `StaffApp`) is referenced by nothing. |
| Staff, DIAGNOSTIC only (`staff-PROBE-entry-wired-*`) | A throwaway build with `index.html` pointed at `src/app/entry.tsx` (probe files deleted, nothing committed; **not the candidate**). Sign-in page and shell render; doctor surface (schedule, notes to sign, alerts) loads (`GET /clinicians/{id}/schedule` 200); `/tasks`, `/arrivals` and the rest of the front-desk nav show a "not available" notice (`StaffApp` mounts only `DoctorPortal`); `/availability`, `/documents` are not in the nav. `GET /api/v1/alerts` 404 and `/alerts/stream` 403 in that probe. No clinical chart, note, referral, reporting, merge or messaging screen was exercised. |
| Brand site, real API (`site-realapi-*`) | **PARTIAL**: all pages render (home, about, services, doctors, locations, contact, robots, healthz, Book hand-off links to the patient portal `/book`). Directory pages show the designed "not available right now" fallback, sitemap 503: the real API does not serve `GET /public/v1/*` (see F18). |
| Brand site, contract mock (`site-fakeapi-*`) | pages with directory data render and the hand-off links carry `?serviceId=&clinicianId=`; the directory is the site's own e2e fake (`apps/site/e2e/fake-api.mjs`), so this is NOT an API integration pass. |

## New findings (returned to Orchestrator; nothing fixed in this round)
- **INT03-F16 (high)**: the staff portal is unreachable. `apps/staff/src/main.tsx` mounts the F-06 placeholder; the auth shell, doctor portal and the other staff features are never served. Even with the entry wired, `StaffApp` mounts only the doctor portal; preconsult/front desk, messages/tasks, availability and documents screens exist as components but are not routed. `entry.tsx` states the Orchestrator was to repoint `main.tsx` (outside the FE-06 allowed paths); no one did. Needs a reviewed fix (entry + routing).
- **INT03-F17 (medium)**: no UI to send or answer a message: patient compose screen absent; staff cannot see or reply to a patient thread (O-2). Acceptance journey "messaging" is only met at the API.
- **INT03-F18 (medium)**: `createIntegrationsHostControllers` (BE integrations host, `GET /public/v1/*`) is exported but never composed into `apps/api/src/composition.ts`; with `EHR_INTEGRATIONS_HOST` set, `/public/v1/services` is 404. The brand site therefore cannot show real directory data.
- Not run: patient merge through the UI, referrals, reporting, clinical chart/notes/front-door journeys in a browser (staff UI unreachable, F16).

## State
Verified: gates above, patient journeys, API message send/receive and boundary, privacy request creation, site render. Not verified: staff UI journeys, real directory on the site, N-1. **Nothing is marked Integrated and nothing is ready for BUILD_REVIEW/QA.** Closing the round per the task: new failures return to the Orchestrator; no further round has been started. Environment notes: Chromium needed libraries from a leftover `/tmp/r5-libs` and fonts from `/tmp/fe07-fonts` (without a font config pages render without text); `ui/launch.sh` shows how staff is served on host `localhost` and patient on `127.0.0.1` (the API picks the realm from the Host header).
