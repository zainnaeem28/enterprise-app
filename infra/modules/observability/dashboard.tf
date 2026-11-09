# One operations dashboard. Metric widgets only: no Logs Insights queries, so nothing on it can show log content.

locals {
  widgets = concat(
    flatten([for _ in local.have_lb ? [1] : [] : [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "Availability: failed requests (percent), SLO ${local.slo.availability_pct} % per month"
          region = var.region, view = "timeSeries", stat = "Sum", period = 300
          metrics = [
            [{ expression = "IF(rq > 0, 100 * (e1 + e2) / rq, 0)", label = "5xx percent", id = "ratio" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { id = "e1", visible = false }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { id = "e2", visible = false }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { id = "rq", visible = false }],
          ]
          annotations = { horizontal = [{ label = "alarm 1 %", value = 1 }] }
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title       = "API latency p95 (seconds), target ${local.slo.api_latency_p95_seconds}"
          region      = var.region, view = "timeSeries", stat = "p95", period = 60
          metrics     = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix]]
          annotations = { horizontal = [{ label = "NFR-6", value = local.slo.api_latency_p95_seconds }] }
        }
      },
    ]]),
    flatten([for _ in local.have_db ? [1] : [] : [
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Database CPU and connections (budget ${var.db_connection_budget})"
          region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Average" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
    ]]),
    flatten([for _ in var.enable_core ? [1] : [] : [
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Queue and outbox (seconds)"
          region = var.region, view = "timeSeries", stat = "Maximum", period = 60
          metrics = [
            [local.app_ns, "QueueOldestJobAgeSeconds"],
            [local.app_ns, "OutboxOldestUnsentAgeSeconds"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "Audit pipeline"
          region = var.region, view = "timeSeries", stat = "Maximum", period = 300
          metrics = [
            [local.app_ns, "AuditAnchorLateSeconds"],
            [local.app_ns, "AuditAnchorArchiveLagSeconds"],
            [local.app_ns, "AuditAnchorVerificationMismatch", { stat = "Sum" }],
            [local.app_ns, "AuditInsertErrors", { stat = "Sum" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title       = "Backup replica lag (seconds)"
          region      = var.region, view = "timeSeries", stat = "Maximum", period = 300
          metrics     = [[local.app_ns, "BackupReplicaLagSeconds"]]
          annotations = { horizontal = [{ label = "alarm 600 s", value = 600 }] }
        }
      },
    ]]),
    flatten([for _ in length(local.canaries_enabled) > 0 ? [1] : [] : [
      {
        type = "metric", x = 0, y = 18, width = 12, height = 6
        properties = {
          title   = "Synthetic checks: success percent"
          region  = var.region, view = "timeSeries", stat = "Average", period = 300
          metrics = [for k, n in local.canary_names : ["CloudWatchSynthetics", "SuccessPercent", "CanaryName", n]]
        }
      },
    ]]),
    flatten([for _ in var.enable_core ? [1] : [] : [
      {
        type = "alarm", x = 12, y = 18, width = 12, height = 6
        properties = {
          title = "Alarm state"
          alarms = concat(
            [for k, a in aws_cloudwatch_metric_alarm.simple : a.arn],
            [for k, a in aws_cloudwatch_composite_alarm.burn : a.arn],
          )
        }
      },
    ]]),
  )
}

resource "aws_cloudwatch_dashboard" "ops" {
  dashboard_name = "${var.name}-operations"
  dashboard_body = jsonencode({ widgets = local.widgets })
}
