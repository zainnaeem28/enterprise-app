# reporting (BE-21)

> Currency note (HEAAA-953, dev 60d962e): `catalog-lists.requested.patch` in this folder is the historical request. The lists in `db/tools/catalog-lists.mjs` are maintained directly and are the source of truth; the entries named here were spot-checked there, the patch is not applied by hand and may no longer apply.

R1 operations read models and the dashboard feed (ARCHITECTURE 22.15, 29.4, 33.1; PRD NFR-21). Migrations `2100`-`2101`.

| Piece                              | What                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `reporting.ops_integration_health` | Per connection: health, circuit state, last success, error rate (5 min, 1 h), dead letters                                          |
| `reporting.ops_queue`              | Per job type: ready, running, failed (retrying), dead, oldest ready age                                                             |
| `reporting.ops_calendar_staleness` | Per clinician with synced busy blocks: last sync, stale flag (`calendar_stale_minutes`)                                             |
| `reporting.ops_alert_backlog`      | Open and escalated staff alerts by type, severity, status: count and oldest age (**design addition, O-1**)                          |
| `reporting.compliance_btg_summary` | Open break-the-glass grants, pending reviews by age (counts only; slice `btg_grants`)                                               |
| `refresh.ts` `runRefreshOps`       | Body of the worker job `reporting.refresh_ops` (every minute): one system transaction, advisory lock, upsert + delete of stale rows |
| `feed.ts` / `controller.ts`        | `GET /api/v1/admin/reports/ops` {`reporting.ops.read`, admin realm}, read under the caller's scope                                  |

## Access (M-1..M-5)

- Every table: `FORCE ROW LEVEL SECURITY`, owned by `app_owner`, role-targeted policies only.
- Writer: `app_worker`, audience `system`, job scope `org`, own organisation. `app_api` has SELECT only (admin realm; compliance summary needs `phi_access = limited` and the `btg_grants` slice).
- `reporting_ro`: SELECT on the four operations tables only, no right on the compliance summary or on anything outside schema `reporting` (M-4). Its session sets `app.org_id` and `app.audience = 'system'`, which keeps its policies from matching `anonymous` or `public` (M-5).
- The models hold counts, ages, states and IDs of connections, job types and clinicians. No patient ID, payload, error text or free text (tests assert the column set and a canary patient ID).

## Wiring (done on dev 60d962e: `createReporting` and `REPORTING_JOBS` in `apps/api/src/composition.ts`, the `reporting.refresh_ops` handler and `REPORTING_CRONTAB` in `apps/worker`; the list below is the original request)

1. Define `REPORTING_JOBS` in the API's and the worker's `JobRegistry` and sync task types; add `REPORTING_CRONTAB` to the worker crontab.
2. Worker handler of `reporting.refresh_ops`: `runRefreshOps({ db, staleMinutes: (tx) => organisation.setting(tx, 'calendar_stale_minutes') }, orgId)`.
3. API: `createReporting({ db }).controllers` next to the other controllers.
4. `catalog-lists.requested.patch` (db/tools): `reporting_ro` in `policyRoles` and the four tables in `reportingViews`. Without it M-3 and M-4-reporting fail.
5. `packages/contracts/openapi/reporting.yaml` types the 200 body as an opaque object; the shape is `OpsFeed` in `feed.ts`.

## Open notes

- **O-1 (Architect).** `ops_alert_backlog` is not listed in 22.15. The ticket asks the feed to show the alert backlog and `notifications.staff_alert` is C2, so a counts-only C1 table was added. Needs Architect acceptance.
- **O-2.** Circuit state is persisted as `integration_core.connection.health` (the in-memory breaker is per process, BE-02). Mapping: `ok` closed, `degraded` half_open, `down` open, `unknown` unknown.
- **O-3.** Dead letters per connection are the dead jobs whose payload carries `connectionId`; jobs without it appear only in `ops_queue.dead`. "Last success" looks back 35 days.
- **O-4.** `ops_calendar_staleness` is derived from `scheduling.busy_block.synced_at`; a clinician with a link but no busy block yet is not listed until the calendar-sync ticket (BE-14) provides a link table to read.
- **O-5.** Queue statistics are deployment-wide (the queue has no organisation column); they are stored under the refreshing organisation.
- **Feed snapshot (BE21-F2).** The feed reads every model in one SQL statement, so a refresh committing mid-read cannot produce a mix of two runs.
- **Dead vs running (BE21-F1).** dead = `locked_at IS NULL AND attempts >= max_attempts`; running = `locked_at IS NOT NULL` (graphile-worker raises `attempts` at lock time).
- **O-6.** The feed is `stale: true` when no model row is younger than 180 s (three missed minutes).
