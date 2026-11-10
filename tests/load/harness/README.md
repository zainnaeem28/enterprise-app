# Load harness plumbing (DO-11)

Tooling the load scripts (QA-07) run on. Environment: `infra/modules/loadtest`.

| File | Purpose |
| --- | --- |
| `k6.version`, `install-k6.sh`, `run-k6.sh` | Pinned, checksum-verified, **unmodified** k6 (AGPL-3.0, test tooling only, never shipped). `run-k6.sh` sets `K6_BINARY_PROVISIONING=false`: k6 v2 otherwise silently downloads a custom (extension) binary when a script imports `k6/x/*`, which decision D-2 forbids. |
| `k6/sse-probe.js` | Capability probe for SSE with built-in k6 only. |
| `sse-client/sse-load.mjs` | Own SSE client (Node built-ins, no dependencies): concurrent streams, time to first event, event rate, heartbeat gaps, unexpected closes, reconnect with `Last-Event-ID`, peak open streams. |
| `sse-fixture/server.mjs` | Local SSE stand-in used to prove the above. Not the API. |
| `seed.sh` | Runs the synthetic-data seeder task and waits. |
| `teardown.sh <root> <run_id>`, `reap-expired.sh`, `guard-cost.sh` (+ `lib-tagged.sh`) | Always-run destroy with all-Region verification, TTL reaper, per-run cost guard. |
| `check-equivalence.mjs` | Compares the loadtest `profile` output with production's; unjustified differences fail. |
| `evidence/` | Raw reports. |

## k6 and SSE: result

Unmodified k6 (`evidence/k6-sse-probe.txt`) measures time to first byte and, after the client times the request out, can
read the buffered body, but every stream ends as a failed request (status 0, `http_req_failed` 100 %), it cannot tell a deliberate
close from a server drop, and it has no per-event timing, heartbeat-gap or `Last-Event-ID` reconnect. Per decision D-2
the fallback applies: `sse-client/sse-load.mjs` (our code) drives the SSE streams; k6 stays for REST/HTTP scenarios. Run A
(`evidence/sse-client-run-A.json`): 500 concurrent streams held, p99 time to first event 6 ms, 0 errors. Run B: server drops streams every 6 s,
100 unexpected closes and 100 reconnects counted. Both against the local fixture only; no number here describes the real API, ALB or CloudFront.
