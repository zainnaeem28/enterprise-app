# CloudWatch alarms. Single-metric alarms and metric-math alarms are two resources fed from local maps; the
# description of every alarm comes from the catalogue (catalog.tf), so owner, impact, first step and runbook cannot be missing.
# Metrics under var.app_metric_namespace are emitted by the application: Unverified until staging.

locals {
  alb_dim = { LoadBalancer = var.alb_arn_suffix }
  app_ns  = var.app_metric_namespace
  have_lb = var.enable_core && var.alb_arn_suffix != ""
  have_db = var.enable_core && var.db_instance_identifier != ""
  core    = var.enable_core
  gib     = 1073741824

  heartbeat_metrics = {
    queue-oldest-job = { metric = "QueueOldestJobAgeSeconds", route = "page" }
    outbox-backlog   = { metric = "OutboxOldestUnsentAgeSeconds", route = "page" }
    staff-scope      = { metric = "StaffScopeDriftCount", route = "security" }
    dead-letter      = { metric = "QueueDeadLetterJobs", route = "page" }
  }

  simple_defaults = {
    dims    = {}
    stat    = "Maximum"
    evals   = 1
    dp      = 1
    missing = "notBreaching"
    op      = "GreaterThanThreshold"
    active  = true
  }

  # --- single-metric alarms ---
  simple_raw = merge(
    # Unhealthy target, one per target group.
    { for tg, sfx in var.target_group_arn_suffixes : "unhealthy-${tg}" => {
      enabled = local.have_lb, catalog = "target_unhealthy", route = "page", ns = "AWS/ApplicationELB", metric = "UnHealthyHostCount"
      dims    = { LoadBalancer = var.alb_arn_suffix, TargetGroup = sfx }, period = 60, evals = 5, dp = 5, threshold = 0
    } },
    # Certificates, one per certificate.
    { for c, arn in var.certificate_arns : "cert-${c}" => {
      enabled = local.core, catalog = "certificate_expiry", route = "ticket", ns = "AWS/CertificateManager", metric = "DaysToExpiry"
      dims    = { CertificateArn = arn }, stat = "Minimum", period = 86400, threshold = 21, op = "LessThanThreshold"
    } },
    # Integration vendors.
    { for v, cfg in var.integration_vendors : "integration-circuit-${v}" => {
      enabled = local.core, catalog = "integration_failure", route = cfg.criticality, ns = local.app_ns, metric = "IntegrationCircuitOpen"
      dims    = { Vendor = v }, period = 60, evals = 3, dp = 3, threshold = 0
    } },
    { for v, cfg in var.integration_vendors : "integration-failure-rate-${v}" => {
      enabled = local.core, catalog = "integration_failure", route = cfg.criticality, ns = local.app_ns, metric = "IntegrationFailureRatePercent"
      dims    = { Vendor = v }, period = 300, evals = 2, dp = 2, threshold = var.integration_failure_rate_threshold_pct
    } },
    # S3 replication to the recovery Region.
    { for r, cfg in var.backup_replication_rules : "s3-replication-${r}" => {
      enabled = local.core, catalog = "s3_replication_failed", route = "page", ns = "AWS/S3", metric = "OperationsFailedReplication"
      dims    = { SourceBucket = cfg.source_bucket, DestinationBucket = cfg.destination_bucket, RuleId = cfg.rule_id }
      stat    = "Sum", period = 300, evals = 1, dp = 1, threshold = 0
    } },
    # WAF blocked-request spikes. CLOUDFRONT-scope metrics exist only in us-east-1 (checked by a precondition).
    { for w, cfg in var.waf_web_acls : "waf-blocks-${w}" => {
      enabled = true, catalog = "waf_block_spike", route = "security", ns = "AWS/WAFV2", metric = "BlockedRequests"
      dims    = { WebACL = w, Rule = "ALL", Region = cfg.scope == "CLOUDFRONT" ? "Global" : var.region }
      stat    = "Sum", period = 300, evals = 2, dp = 2, threshold = var.waf_blocked_requests_threshold
    } },
    # PHI-like pattern found in application logs by the data-protection policy. Counted from the findings log group
    # by a metric filter (dataprotection.tf), so the alarm does not depend on the dimensions of the service's own metric.
    {
      "phi-in-logs" = {
        enabled = local.core, catalog = "phi_pattern_in_logs", route = "security", ns = local.app_ns, metric = "PhiFindingEvents"
        stat    = "Sum", period = 60, threshold = 0
      }
    },
    # Silent emitters: each application metric below must be published every period (zero when idle). If it stops,
    # the sample count drops and the alarm fires, so a dead worker or broken emission cannot look healthy.
    { for m, cfg in local.heartbeat_metrics : "metrics-silent-${m}" => {
      enabled = local.core, catalog = "app_metrics_silent", route = cfg.route, ns = local.app_ns, metric = cfg.metric
      stat    = "SampleCount", period = 300, evals = 2, dp = 2, threshold = 1, op = "LessThanThreshold", missing = "breaching"
      active  = var.app_metrics_heartbeat_enabled
    } },
    # Canary failures (ticket or page by host).
    { for c, cfg in local.canaries_enabled : "canary-${c}" => {
      enabled = local.core, catalog = "synthetic_failed", route = cfg.page_on_failure ? "page" : "ticket", ns = "CloudWatchSynthetics", metric = "SuccessPercent"
      dims    = { CanaryName = local.canary_names[c] }, stat = "Average", period = 60 * cfg.every_minutes
      evals   = cfg.every_minutes == 1 ? 3 : 2, dp = cfg.every_minutes == 1 ? 3 : 2, threshold = 100, op = "LessThanThreshold", missing = "breaching"
    } },
    {
      "api-latency" = {
        enabled = local.have_lb, catalog = "api_latency", route = "page", ns = "AWS/ApplicationELB", metric = "TargetResponseTime"
        dims    = local.alb_dim, stat = "p95", period = 60, evals = 10, dp = 10, threshold = local.slo.api_latency_p95_seconds
      }
      "slot-search-latency" = {
        enabled = local.core, catalog = "slot_search_latency", route = "ticket", ns = local.app_ns, metric = "SlotSearchDurationSeconds"
        stat    = "p95", period = 300, evals = 2, dp = 2, threshold = local.slo.slot_search_p95_seconds
      }
      "db-cpu" = {
        enabled = local.have_db, catalog = "db_cpu", route = "page", ns = "AWS/RDS", metric = "CPUUtilization"
        dims    = { DBInstanceIdentifier = var.db_instance_identifier }, stat = "Average", period = 60, evals = 10, dp = 10, threshold = 80
      }
      "db-storage" = {
        enabled   = local.have_db, catalog = "db_storage", route = "page", ns = "AWS/RDS", metric = "FreeStorageSpace"
        dims      = { DBInstanceIdentifier = var.db_instance_identifier }, stat = "Minimum", period = 300
        threshold = 0.2 * var.db_allocated_storage_gb * local.gib, op = "LessThanThreshold"
      }
      "db-connections" = {
        enabled = local.have_db, catalog = "db_connections", route = "page", ns = "AWS/RDS", metric = "DatabaseConnections"
        dims    = { DBInstanceIdentifier = var.db_instance_identifier }, period = 60, evals = 5, dp = 5, threshold = 0.7 * var.db_connection_budget
      }
      "queue-oldest-job" = {
        enabled = local.core, catalog = "queue_oldest_job", route = "page", ns = local.app_ns, metric = "QueueOldestJobAgeSeconds"
        period  = 60, evals = 5, dp = 5, threshold = 300
      }
      "outbox-backlog" = {
        enabled = local.core, catalog = "outbox_backlog", route = "page", ns = local.app_ns, metric = "OutboxOldestUnsentAgeSeconds"
        period  = 60, evals = 5, dp = 5, threshold = var.outbox_age_threshold_seconds
      }
      "audit-anchor-late" = {
        enabled = local.core, catalog = "audit_anchor_late", route = "security", ns = local.app_ns, metric = "AuditAnchorLateSeconds"
        period  = 60, evals = 3, dp = 3, threshold = var.audit_anchor_late_threshold_seconds, missing = "breaching"
      }
      "audit-anchor-archive-late" = {
        enabled = local.core, catalog = "audit_anchor_archive_late", route = "security", ns = local.app_ns, metric = "AuditAnchorArchiveLagSeconds"
        period  = 60, evals = 3, dp = 3, threshold = 900, missing = "breaching"
      }
      "audit-anchor-mismatch" = {
        enabled = local.core, catalog = "audit_anchor_mismatch", route = "security", ns = local.app_ns, metric = "AuditAnchorVerificationMismatch"
        stat    = "Sum", period = 300, threshold = 0
      }
      "audit-insert-errors" = {
        enabled = local.core, catalog = "audit_insert_errors", route = "security", ns = local.app_ns, metric = "AuditInsertErrors"
        stat    = "Sum", period = 60, threshold = 0
      }
      "audit-late-committed" = {
        enabled = local.core, catalog = "audit_late_committed", route = "security", ns = local.app_ns, metric = "AuditLateCommittedRows"
        stat    = "Sum", period = 300, threshold = 0
      }
      "staff-scope-drift" = {
        enabled = local.core, catalog = "staff_scope_drift", route = "security", ns = local.app_ns, metric = "StaffScopeDriftCount"
        period  = 300, threshold = 0
      }
      "backup-stale" = {
        enabled = local.core && var.backup_vault_name != "", catalog = "backup_stale", route = "page", ns = "AWS/Backup", metric = "NumberOfBackupJobsCompleted"
        dims    = { BackupVaultName = var.backup_vault_name }, stat = "Sum", period = 3600, evals = 26, dp = 26, threshold = 1
        op      = "LessThanThreshold", missing = "breaching"
      }
      "backup-replica-lag" = {
        enabled = local.core && var.recovery_region != "", catalog = "backup_replica_lag", route = "page", ns = local.app_ns, metric = "BackupReplicaLagSeconds"
        period  = 300, evals = 2, dp = 2, threshold = 600, missing = "breaching", active = var.backup_replica_first_report_seen
      }
      "backup-lag-lookup-failed" = {
        enabled = local.core && var.recovery_region != "", catalog = "backup_lag_lookup_failed", route = "page", ns = local.app_ns, metric = "BackupReplicaLookupFailed"
        stat    = "Sum", period = 300, evals = 2, dp = 2, threshold = 0, active = var.backup_replica_first_report_seen
      }
      "restore-test-failed" = {
        enabled = local.core, catalog = "restore_test_failed", route = "ticket", ns = local.app_ns, metric = "RestoreTestFailed"
        stat    = "Sum", period = 86400, threshold = 0
      }
    },
  )

  simple = {
    for k, v in local.simple_raw : k => merge(local.simple_defaults, v) if v.enabled
  }

  # --- metric-math alarms ---
  math_raw = {
    "alb-5xx-rate" = {
      enabled   = local.have_lb, catalog = "alb_5xx", route = "page", period = 60, evals = 5, dp = 5
      threshold = 1, queries = local.err_queries
    }
    "burn-fast-long" = {
      enabled   = local.have_lb, catalog = "error_budget_fast_burn", route = "none", period = 3600, evals = 1, dp = 1
      threshold = 14.4 * local.error_budget_pct, queries = local.err_queries
    }
    "burn-fast-short" = {
      enabled   = local.have_lb, catalog = "error_budget_fast_burn", route = "none", period = 300, evals = 1, dp = 1
      threshold = 14.4 * local.error_budget_pct, queries = local.err_queries
    }
    "burn-slow-long" = {
      enabled   = local.have_lb, catalog = "error_budget_slow_burn", route = "none", period = 21600, evals = 1, dp = 1
      threshold = 6 * local.error_budget_pct, queries = local.err_queries
    }
    "burn-slow-short" = {
      enabled   = local.have_lb, catalog = "error_budget_slow_burn", route = "none", period = 1800, evals = 1, dp = 1
      threshold = 6 * local.error_budget_pct, queries = local.err_queries
    }
    "queue-dead-letter-growth" = {
      enabled = local.core, catalog = "queue_dead_letter", route = "page", period = 300, evals = 3, dp = 1, threshold = 0
      queries = [
        { id = "dl", expr = null, ns = local.app_ns, metric = "QueueDeadLetterJobs", dims = {}, stat = "Maximum", ret = false },
        { id = "growth", expr = "DIFF(dl)", ns = null, metric = null, dims = {}, stat = null, ret = true },
      ]
    }
  }

  math = { for k, v in local.math_raw : k => v if v.enabled }

  err_queries = [
    { id = "e1", expr = null, ns = "AWS/ApplicationELB", metric = "HTTPCode_ELB_5XX_Count", dims = local.alb_dim, stat = "Sum", ret = false },
    { id = "e2", expr = null, ns = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", dims = local.alb_dim, stat = "Sum", ret = false },
    { id = "rq", expr = null, ns = "AWS/ApplicationELB", metric = "RequestCount", dims = local.alb_dim, stat = "Sum", ret = false },
    { id = "ratio", expr = "IF(rq > 0, 100 * (e1 + e2) / rq, 0)", ns = null, metric = null, dims = {}, stat = null, ret = true },
  ]

  topic_arn = { for t, v in aws_sns_topic.route : t => v.arn }
}

resource "aws_cloudwatch_metric_alarm" "simple" {
  for_each = local.simple

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = local.catalog_text[each.value.catalog]
  namespace           = each.value.ns
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = contains(["p95", "p99"], each.value.stat) ? null : each.value.stat
  extended_statistic  = contains(["p95", "p99"], each.value.stat) ? each.value.stat : null
  period              = each.value.period
  evaluation_periods  = each.value.evals
  datapoints_to_alarm = each.value.dp
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = each.value.missing
  actions_enabled     = each.value.active
  alarm_actions       = [local.topic_arn[each.value.route]]
  ok_actions          = each.value.route == "ticket" ? [] : [local.topic_arn[each.value.route]]
  tags                = merge(var.tags, { AlertCatalogId = each.value.catalog })

  lifecycle {
    precondition {
      condition     = lookup(each.value.dims, "Region", "") != "Global" || var.region == "us-east-1"
      error_message = "CloudFront-scope WAF metrics exist only in us-east-1; instantiate this module there with enable_core = false."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "math" {
  for_each = local.math

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = local.catalog_text[each.value.catalog]
  evaluation_periods  = each.value.evals
  datapoints_to_alarm = each.value.dp
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = true
  # Components of a multi-window burn alarm have no action of their own; the composite below pages.
  alarm_actions = each.value.route == "none" ? [] : [local.topic_arn[each.value.route]]
  tags          = merge(var.tags, { AlertCatalogId = each.value.catalog })

  dynamic "metric_query" {
    for_each = each.value.queries
    content {
      id          = metric_query.value.id
      expression  = metric_query.value.expr
      label       = metric_query.value.id
      return_data = metric_query.value.ret
      dynamic "metric" {
        for_each = metric_query.value.metric == null ? [] : [1]
        content {
          namespace   = metric_query.value.ns
          metric_name = metric_query.value.metric
          dimensions  = metric_query.value.dims
          period      = each.value.period
          stat        = metric_query.value.stat
        }
      }
    }
  }
}

# Multi-window burn rate: both windows must be in alarm (DEVOPS-PLAN 11.3).
resource "aws_cloudwatch_composite_alarm" "burn" {
  for_each = local.have_lb ? {
    error-budget-fast-burn = { catalog = "error_budget_fast_burn", long = "burn-fast-long", short = "burn-fast-short" }
    error-budget-slow-burn = { catalog = "error_budget_slow_burn", long = "burn-slow-long", short = "burn-slow-short" }
  } : {}

  alarm_name        = "${var.name}-${each.key}"
  alarm_description = local.catalog_text[each.value.catalog]
  alarm_rule        = "ALARM(${aws_cloudwatch_metric_alarm.math[each.value.long].alarm_name}) AND ALARM(${aws_cloudwatch_metric_alarm.math[each.value.short].alarm_name})"
  alarm_actions     = [local.topic_arn.page]
  ok_actions        = [local.topic_arn.page]
  tags              = merge(var.tags, { AlertCatalogId = each.value.catalog })
}
