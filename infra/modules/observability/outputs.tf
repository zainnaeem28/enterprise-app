output "topic_arns" {
  description = "Alert topics by route: page, ticket, security."
  value       = local.topic_arn
}

output "alert_catalog" {
  description = "Every alert with owner, impact, first diagnostic step, runbook link and where it is raised."
  value = {
    for id, c in local.catalog : id => {
      owner    = c.owner
      impact   = c.impact
      first    = c.first
      runbook  = "${var.runbook_base}#${id}"
      severity = c.severity
      source   = c.source
    }
  }
}

output "alarm_catalog_ids" {
  description = "Catalogue id of every alarm, rule and subscription this module creates, by resource name."
  value = merge(
    { for k, v in local.simple : "${var.name}-${k}" => v.catalog },
    { for k, v in local.math : "${var.name}-${k}" => v.catalog },
    { for k, v in aws_cloudwatch_composite_alarm.burn : "${var.name}-${k}" => v.tags["AlertCatalogId"] },
    { for k, v in local.event_rules : "${var.name}-${k}" => v.catalog },
  )
}

output "alarm_names" {
  value = sort(concat(
    [for a in aws_cloudwatch_metric_alarm.simple : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.math : a.alarm_name],
    [for a in aws_cloudwatch_composite_alarm.burn : a.alarm_name],
  ))
}

output "slo_targets" {
  description = "Approved targets (PRD NFR-1..8). Fixed in the module; no input lowers them."
  value       = local.slo
}

output "slo_table" {
  value = local.slo_table
}

output "paging_status" {
  description = "Honest delivery status. The 99.9 % target is not claimed as met until a rota is named and a test page is acknowledged (D-29, C-18)."
  value = {
    page_subscribers       = length(var.page_email_endpoints)
    security_subscribers   = length(var.security_email_endpoints)
    ticket_subscribers     = length(var.ticket_email_endpoints)
    on_call_rota_named     = var.on_call_rota_named
    availability_claimed   = var.on_call_rota_named && length(var.page_email_endpoints) > 0
    delivery_test_evidence = "not executed: SNS email subscriptions need confirmation and a named person must acknowledge a test alert before go-live"
  }
}

output "canary_monthly_cost_usd" {
  description = "Estimated canary run cost (price per run verified 2026-11-04; Lambda and S3 artifact cost extra and unverified)."
  value       = { per_canary = local.canary_cost_usd, total = sum(concat([0], values(local.canary_cost_usd))) }
}

output "adot_collector_config_parameter_arn" {
  description = "Give this to the compute module as the AOT_CONFIG_CONTENT secret (valueFrom) of the sidecar."
  value       = try(aws_ssm_parameter.collector_config[0].arn, "")
}

output "adot_collector_config" {
  value = local.collector_yaml
}

output "adot_container_definition" {
  description = "Sidecar container definition fragment for the compute module (a change outside this ticket; request through the Orchestrator)."
  value = var.adot_image == "" || !var.enable_core ? null : {
    name                   = "adot-collector"
    image                  = var.adot_image
    essential              = false
    cpu                    = 128
    memory                 = 256
    user                   = "10001"
    readonlyRootFilesystem = true
    secrets                = [{ name = "AOT_CONFIG_CONTENT", valueFrom = aws_ssm_parameter.collector_config[0].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.adot[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "adot"
      }
    }
  }
}

output "app_otel_environment" {
  description = "Environment for the api and worker containers. Matches the defaults in apps/api/src/telemetry/config.ts."
  value = {
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_TRACES_SAMPLER         = "parentbased_always_on"
    OTEL_SERVICE_NAME           = "ehr-api"
    EHR_TELEMETRY               = "on"
  }
}

output "adot_task_role_policy_json" {
  description = "Statements the task role needs for the sidecar (X-Ray, EMF log group). Attach through the identity module."
  value = var.enable_core ? jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Traces", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], Resource = "*" },
      { Sid = "EmfLogs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.emf[0].arn}:*" },
    ]
  }) : null
}

output "kms_key_policy_requirements" {
  description = "The key in kms_key_arn must allow these service principals to use it, or alarm delivery to the encrypted topics fails (a change in the kms module, not here)."
  value = [
    "cloudwatch.amazonaws.com: kms:Decrypt, kms:GenerateDataKey* (alarm to SNS)",
    "events.amazonaws.com: kms:Decrypt, kms:GenerateDataKey* (EventBridge to SNS)",
    "budgets.amazonaws.com and rds.amazonaws.com: kms:Decrypt, kms:GenerateDataKey* (budgets, RDS events)",
    "logs.<region>.amazonaws.com: kms:Encrypt*, kms:Decrypt*, kms:GenerateDataKey* (encrypted log groups)",
  ]
}

output "data_protection_policy" {
  description = "Rendered log data-protection policy, for the PHI canary test."
  value       = jsonencode(local.data_protection_policy)
}

output "alarm_routes" {
  description = "Route (page, ticket, security) of every alarm and rule; component alarms of a burn-rate pair have none."
  value = merge(
    { for k, v in local.simple : "${var.name}-${k}" => v.route },
    { for k, v in local.math : "${var.name}-${k}" => v.route },
    { for k, v in local.event_rules : "${var.name}-${k}" => v.route },
  )
}
