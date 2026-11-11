# The alert catalogue (DEVOPS-PLAN 11.3) and the SLO table (11.2). Every entry carries owner, impact, first diagnostic
# step and runbook; the alarm description is built from the entry, so an alarm cannot exist without them.
# Owners are roles, not people: no on-call rota is named (D-29, C-18).

locals {
  owners = {
    devops   = "DevOps on-call (rota not yet named, C-18)"
    backend  = "Backend on-call (worker, queue, audit; rota not yet named, C-18)"
    security = "Security contact"
    ops      = "Operations owner"
    release  = "Releasing engineer"
  }

  # severity: page | ticket | security. "external" entries are raised by something outside this module.
  catalog = {
    error_budget_fast_burn = {
      owner    = local.owners.devops
      impact   = "Users see failed requests fast enough to spend the monthly error budget (about 43 minutes) in roughly two days or less."
      first    = "Check the last deploy; consider application rollback (DEVOPS-PLAN 9.3)."
      severity = "page", source = "alarm"
    }
    error_budget_slow_burn = {
      owner    = local.owners.devops
      impact   = "A steady error rate is consuming the monthly error budget well ahead of schedule."
      first    = "Check the last deploy and the ALB 5xx by target group; consider rollback (DEVOPS-PLAN 9.3)."
      severity = "page", source = "alarm"
    }
    alb_5xx = {
      owner    = local.owners.devops
      impact   = "More than 1 % of requests fail at the load balancer; patients or staff cannot complete work."
      first    = "Open the service health in ECS and the task logs for the failing target group."
      severity = "page", source = "alarm"
    }
    target_unhealthy = {
      owner    = local.owners.devops
      impact   = "A task is failing health checks; capacity is reduced and a rollout may be failing."
      first    = "Open the service health and task logs; check the last deploy."
      severity = "page", source = "alarm"
    }
    api_latency = {
      owner    = local.owners.devops
      impact   = "API p95 above 500 ms for 10 minutes; screens feel slow and the NFR-6 target is missed."
      first    = "Check database load, row-level-security query cost and connection counts."
      severity = "page", source = "alarm"
    }
    slot_search_latency = {
      owner    = local.owners.devops
      impact   = "Slot search p95 above 1 s (NFR-8); booking is slow."
      first    = "Check database load and the slot-search query plans; check connection counts."
      severity = "ticket", source = "alarm"
    }
    db_cpu = {
      owner    = local.owners.devops
      impact   = "Database CPU above 80 % for 10 minutes; latency and the connection budget are at risk."
      first    = "Open Performance Insights top SQL and check the last deploy and any long migration."
      severity = "page", source = "alarm"
    }
    db_storage = {
      owner    = local.owners.devops
      impact   = "Less than 20 % free database storage; writes stop if it fills."
      first    = "Check growth by table and the audit partitions; plan a storage increase."
      severity = "page", source = "alarm"
    }
    db_connections = {
      owner    = local.owners.devops
      impact   = "Connections above 70 % of the budget (ARCHITECTURE 9.2); a deploy peak could exhaust them."
      first    = "Check connection counts by role and pool sizes; hold rollouts."
      severity = "page", source = "alarm"
    }
    db_events = {
      owner    = local.owners.devops
      impact   = "RDS reported a failover, failure or availability event; standby or primary health changed."
      first    = "Read the RDS event, confirm the writer and application reconnects, check replication state."
      severity = "page", source = "event"
    }
    queue_oldest_job = {
      owner    = local.owners.backend
      impact   = "The oldest queued job is more than 5 minutes old; reminders, retries, scanning or anchoring are late."
      first    = "Check worker logs and running worker tasks; check integration status for stuck retries."
      severity = "page", source = "alarm"
    }
    app_metrics_silent = {
      owner    = local.owners.backend
      impact   = "An application metric used for queue, outbox, dead-letter or staff-scope alarms stopped arriving; those alarms are blind."
      first    = "Check that the worker and API tasks are running and the metric emitter logs; the matching alarm name says which metric."
      severity = "page", source = "alarm"
    }
    queue_dead_letter = {
      owner    = local.owners.backend
      impact   = "Jobs are failing permanently (dead-letter growth)."
      first    = "Read the worker logs for the failing job type; do not delete or replay jobs that carry patient identifiers without the worker owner."
      severity = "page", source = "alarm"
    }
    outbox_backlog = {
      owner    = local.owners.backend
      impact   = "Domain events are not being sent; downstream effects (notifications, integrations) are delayed."
      first    = "Check worker logs and the outbox dispatcher."
      severity = "page", source = "alarm"
    }
    integration_failure = {
      owner    = local.owners.backend
      impact   = "A vendor integration has an open circuit or a high failure rate (BR-33); the affected feature degrades."
      first    = "Check the vendor status page and the retry state of the integration."
      severity = "page or ticket by vendor criticality", source = "alarm"
    }
    secret_replica_not_in_sync = {
      owner    = local.owners.devops
      impact   = "A runtime integration secret would be missing or stale in the recovery Region at failover."
      first    = "Worker log lines event=secret_replica_unhealthy; repair with replicate-secret-to-regions; runbook recovery-region 2.2."
      severity = "ticket", source = "alarm"
    }
    audit_anchor_late = {
      owner    = local.owners.security
      impact   = "Audit anchors are not being written; tamper evidence has a gap."
      first    = "Follow the security runbook; check the anchoring job in worker logs. Do not alter data."
      severity = "security", source = "alarm"
    }
    audit_anchor_archive_late = {
      owner    = local.owners.security
      impact   = "Audit anchors are not reaching the Object Lock archive; a database-level rewrite of recent anchors would go undetected until they are archived."
      first    = "Follow the security runbook; check the archive_anchors job and its access to the archive bucket (anchors/ prefix) in worker logs. Do not alter data."
      severity = "security", source = "alarm"
    }
    audit_anchor_mismatch = {
      owner    = local.owners.security
      impact   = "Anchor verification mismatch: the audit record may have been altered or lost."
      first    = "Follow the security runbook; preserve evidence; do not alter data."
      severity = "security", source = "alarm"
    }
    audit_insert_errors = {
      owner    = local.owners.security
      impact   = "Audit inserts are failing; audited actions may be refused or unrecorded."
      first    = "Follow the security runbook; check database errors and the audit role's limits."
      severity = "security", source = "alarm"
    }
    audit_late_committed = {
      owner    = local.owners.security
      impact   = "A row committed behind the anchor watermark and was flagged (ARCHITECTURE 6)."
      first    = "Follow the security runbook; identify the transaction; do not alter data."
      severity = "security", source = "alarm"
    }
    staff_scope_drift = {
      owner    = local.owners.security
      impact   = "patient.verify_staff_scope reports drift: staff may see patients outside their scope (also a clinical-safety issue)."
      first    = "Recompute through the function (SHARED-BOUNDARIES 6.6) and file a finding; do not edit scope rows by hand."
      severity = "security", source = "alarm"
    }
    backup_stale = {
      owner    = local.owners.devops
      impact   = "No successful backup job in 26 hours; the 15-minute RPO is at risk."
      first    = "Backup runbook: check AWS Backup job failures and RDS automated backups."
      severity = "page", source = "alarm"
    }
    backup_replica_lag = {
      owner    = local.owners.devops
      impact   = "The recovery-Region backup copy is more than 10 minutes behind or not reporting; RPO in a Region loss is at risk."
      first    = "Backup runbook: check the lag Lambda, then the replication status in the recovery Region."
      severity = "page", source = "alarm"
    }
    backup_lag_lookup_failed = {
      owner    = local.owners.devops
      impact   = "The backup-lag Lambda could not read the replica; the lag alarm cannot be trusted."
      first    = "Backup runbook: read the Lambda logs; confirm the API returns a latest restorable time (Unverified until the staging rehearsal)."
      severity = "page", source = "alarm"
    }
    s3_replication_failed = {
      owner    = local.owners.devops
      impact   = "S3 replication to the recovery Region is failing; audit archive or backup copies are not replicating."
      first    = "Backup runbook: check the replication rule status and the destination bucket policy."
      severity = "page", source = "alarm"
    }
    restore_test_failed = {
      owner    = local.owners.devops
      impact   = "The monthly restore test failed; recoverability is unproven."
      first    = "Backup runbook: read the restore-test job output."
      severity = "ticket", source = "alarm"
    }
    certificate_expiry = {
      owner    = local.owners.devops
      impact   = "A certificate expires in under 21 days; hosts will fail TLS when it does."
      first    = "Check ACM validation records and DNS for the certificate."
      severity = "ticket", source = "alarm"
    }
    guardduty_high = {
      owner    = local.owners.security
      impact   = "GuardDuty reported a high-severity finding."
      first    = "Follow the security runbook; open the finding."
      severity = "security", source = "event"
    }
    waf_block_spike = {
      owner    = local.owners.security
      impact   = "WAF blocked-request volume is unusually high; possible attack or a rule blocking real users."
      first    = "Follow the security runbook; sample blocked requests by rule."
      severity = "security", source = "alarm"
    }
    cloudtrail_change = {
      owner    = local.owners.security
      impact   = "Logging configuration was changed (stop, delete, update, selectors); evidence may be lost."
      first    = "Follow the security runbook; identify the principal; restore logging through IaC."
      severity = "security", source = "event"
    }
    root_login = {
      owner    = local.owners.security
      impact   = "The AWS root user signed in."
      first    = "Follow the security runbook; confirm with the platform admins."
      severity = "security", source = "event"
    }
    break_glass_use = {
      owner    = local.owners.security
      impact   = "A break-glass role was assumed."
      first    = "Follow the security runbook; confirm an approved incident exists."
      severity = "security", source = "event"
    }
    phi_pattern_in_logs = {
      owner    = local.owners.security
      impact   = "The log data-protection policy found a PHI-like pattern in application logs: the logger allowlist was bypassed (NFR-18)."
      first    = "Follow the security runbook; find the log statement from the request id; fix the logger; assess disclosure."
      severity = "security", source = "alarm"
    }
    synthetic_failed = {
      owner    = local.owners.devops
      impact   = "An external reachability check (DNS, TLS, edge path or page load) is failing."
      first    = "Open the canary run artifacts (status and timing only); check DNS, certificate and the edge."
      severity = "page or ticket by host", source = "alarm"
    }
    cost_budget = {
      owner    = local.owners.ops
      impact   = "Forecast or actual spend crossed a budget threshold."
      first    = "Open the cost breakdown for the account (DEVOPS-PLAN 13) and the service that moved."
      severity = "ticket", source = "budget"
    }
    deployment_migration_failed = {
      owner    = local.owners.release
      impact   = "The migration task exited with an error; the release must not proceed."
      first    = "Read the migration task logs; follow DEVOPS-PLAN 9.3 (a database restore is not implied by an application rollback)."
      severity = "page", source = "event"
    }
    deployment_failed = {
      owner    = local.owners.release
      impact   = "An ECS deployment failed or the circuit breaker rolled it back."
      first    = "Read the service events and task stop reasons; follow DEVOPS-PLAN 9.3."
      severity = "page", source = "event"
    }
    release_workflow_failed = {
      owner    = local.owners.release
      impact   = "The release workflow failed."
      first    = "Open the workflow run; follow DEVOPS-PLAN 9.3."
      severity = "page", source = "external:GitHub Actions workflow notifications (DO-05, DO-06)"
    }
    workspace_admin_change = {
      owner    = local.owners.security
      impact   = "Google Workspace super-admin or organisational-unit change (C3)."
      first    = "Follow the security runbook; compare with the approved change list."
      severity = "security", source = "external:Workspace admin audit log (no ingestion defined; DEVOPS-PLAN 16.3)"
    }
  }

  catalog_text = {
    for id, c in local.catalog : id => "${c.owner} | Impact: ${c.impact} | First step: ${c.first} | Runbook: ${var.runbook_base}#${id}"
  }

  # Approved targets (PRD NFR-1..4, NFR-6..8; DEVOPS-PLAN 11.2). Fixed here: nothing lowers them by variable.
  slo = {
    availability_pct        = 99.9
    api_latency_p95_seconds = 0.5
    slot_search_p95_seconds = 1.0
    lcp_seconds             = 2.5
    rpo_minutes             = 15
    rto_hours               = 4
  }
  error_budget_pct = 100 - local.slo.availability_pct

  slo_table = [
    { slo = "Availability of my. and staff.", target = "99.9 % of valid requests succeed", window = "Calendar month", source = "NFR-1" },
    { slo = "API latency", target = "p95 < 500 ms", window = "5-minute windows, monthly attainment", source = "NFR-6" },
    { slo = "Slot search", target = "p95 < 1 s", window = "5-minute windows, monthly attainment", source = "NFR-8" },
    { slo = "LCP", target = "< 2.5 s on 4G", window = "Lab per release; field RUM on the brand site only", source = "NFR-7" },
    { slo = "Alert delivery", target = "Staff alert delivered within the configured window (D-11); unacknowledged alerts escalate in time", window = "Continuous", source = "J-07, J-17" },
    { slo = "Recovery", target = "RPO <= 15 min, RTO <= 4 h", window = "Per rehearsal", source = "NFR-2/3" },
  ]
}
