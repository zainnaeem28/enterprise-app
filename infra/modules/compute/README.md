# compute module (DO-03, authored, not applied)

ECS Fargate cluster, `api` and `worker` services, public ALB with host routing, target group, auto-scaling.

- Rolling deployment 100 % / 150 %, circuit breaker with rollback (DEVOPS-PLAN 9.1). `desired_count` is ignored after creation (auto-scaling owns it).
- Ceilings validated from the database connection budget: `api` max 8, `worker` max 4; floor 2 (DEVOPS-PLAN 12).
- Images must be `repo@sha256:<digest>` (build once, promote the digest).
- ALB: portal hosts reach `/api/*` only with the origin-verify header that CloudFront adds; `integrations.` is routed by host only (cookies are rejected by the WAF in `edge`); anything else gets 403. Target group health check is liveness `/healthz`.
- SSE: ALB idle timeout 60 s, heartbeat 15 s, deregistration delay 120 s, long scale-in cooldown. A precondition fails the plan if the heartbeat is not shorter than the ALB idle and CloudFront origin read timeouts.
- IAM roles, ECR, secrets, the database security group and DNS are inputs or later tickets (DO-04 and others).

## Open items (not decided here)

- **ALB to task is HTTPS by default** (`backend_protocol`, health check follows). The api container must serve TLS on `container_port` (self-signed is fine; the ALB does not validate it) - a requirement on the application/image tickets. HTTP is accepted only outside production and with `plaintext_backend_exception_ref` naming a written Solution Architect/Security exception; none exists. Unverified until staging.
- **Wiring**: `portal_hosts` here and in `edge`, and the CloudFront origin read timeout in `edge` versus `sse_heartbeat_seconds`, must be fed from the same root-module values; the plan precondition only checks the timeouts it is given.
- `origin_verify_secret` is a plain sensitive variable, so it is in state and in the listener rule. Rotation and the secret-store source belong to DO-04 / the pipeline.
- Scaling targets (CPU 60 %, 500 requests per target) are placeholders until the load test. Worker scaling on queue depth needs a custom metric from the application (not available here).
- Rollout refusal above 6 api / 3 worker tasks and holding auto-scaling during a rollout are pipeline rules, not in this module.
- Everything about runtime behaviour (SSE through ALB, drain, circuit-breaker rollback) is **Unverified until staging**.
