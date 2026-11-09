# Plan-level tests on a mock AWS provider. Nothing here talks to AWS; no apply anywhere.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-2:111111111111:t-alerts" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:us-east-2:111111111111:parameter/t/observability/adot-collector-config" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:111111111111:log-group:/t/x" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-2:111111111111:alarm:t-x" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/t" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:111111111111:function:t" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-2:111111111111:rule/t" }
  }
}

variables {
  name                      = "t"
  region                    = "us-east-2"
  account_id                = "111111111111"
  kms_key_arn               = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  alb_arn_suffix            = "app/t-alb/1111111111111111"
  target_group_arn_suffixes = { api = "targetgroup/api/3333333333333333" }
  ecs_cluster_name          = "t"
  db_instance_identifier    = "t-db"
  log_group_names           = ["/t/api", "/t/worker"]
  certificate_arns          = { my = "arn:aws:acm:us-east-2:111111111111:certificate/11111111-1111-1111-1111-111111111111" }
  waf_web_acls              = { t-alb = { scope = "REGIONAL" } }
  backup_vault_name         = "t-vault"
  recovery_region           = "us-west-2"
  backup_replication_rules  = { audit = { source_bucket = "a", destination_bucket = "b", rule_id = "all" } }
  integration_vendors       = { sms = { criticality = "page" }, video = { criticality = "ticket" } }
  break_glass_role_arns     = ["arn:aws:iam::111111111111:role/bg-admin"]
  migration_task_family     = "t-migrate"
  monthly_budget_usd        = 1000
  extra_budgets             = { sms = { limit_usd = 100, cost_filters = { Service = ["Amazon Simple Notification Service"] } } }
  page_email_endpoints      = ["oncall@example.test"]
  adot_image                = "111111111111.dkr.ecr.us-east-2.amazonaws.com/adot@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  canary_artifacts_bucket   = "t-canary"
  canaries = {
    my-shallow    = { url = "https://my.example.test/healthz", kind = "shallow", every_minutes = 1, page_on_failure = true }
    staff-shallow = { url = "https://staff.example.test/healthz", kind = "shallow", every_minutes = 1, page_on_failure = true }
    my-journey    = { url = "https://my.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    staff-journey = { url = "https://staff.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    integrations  = { url = "https://integrations.example.test/public/v1", kind = "journey", every_minutes = 5, page_on_failure = false }
    pharmacy      = { url = "https://pharmacy.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    www           = { url = "https://www.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    cms           = { url = "https://cms.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
  }
}

run "every_alert_has_owner_impact_first_step_runbook" {
  command = plan

  assert {
    condition = alltrue([
      for id, c in output.alert_catalog :
      length(c.owner) > 0 && length(c.impact) > 0 && length(c.first) > 0 && startswith(c.runbook, "docs/runbooks/OPERATIONS-RUNBOOKS.md#")
    ])
    error_message = "A catalogue entry lacks owner, impact, first step or runbook."
  }
  assert {
    condition = alltrue(flatten([
      [for k, a in aws_cloudwatch_metric_alarm.simple : strcontains(a.alarm_description, "Impact:") && strcontains(a.alarm_description, "First step:") && strcontains(a.alarm_description, "Runbook:") && strcontains(a.alarm_description, "|")],
      [for k, a in aws_cloudwatch_metric_alarm.math : strcontains(a.alarm_description, "Impact:") && strcontains(a.alarm_description, "First step:") && strcontains(a.alarm_description, "Runbook:")],
      [for k, a in aws_cloudwatch_composite_alarm.burn : strcontains(a.alarm_description, "Runbook:")],
      [for k, a in aws_cloudwatch_event_rule.alert : strcontains(a.description, "Runbook:")],
    ]))
    error_message = "An alarm or rule description does not carry the catalogue text."
  }
  assert {
    condition     = alltrue([for name, id in output.alarm_catalog_ids : contains(keys(output.alert_catalog), id)])
    error_message = "An alarm points at an id that is not in the catalogue."
  }
  assert {
    condition     = alltrue([for id, c in output.alert_catalog : contains(["alarm", "event", "budget"], c.source) || startswith(c.source, "external:")])
    error_message = "A catalogue entry has no declared source."
  }
}

run "slo_table_matches_approved_targets" {
  command = plan

  assert {
    condition     = output.slo_targets.availability_pct == 99.9 && output.slo_targets.api_latency_p95_seconds == 0.5 && output.slo_targets.slot_search_p95_seconds == 1 && output.slo_targets.lcp_seconds == 2.5 && output.slo_targets.rpo_minutes == 15 && output.slo_targets.rto_hours == 4
    error_message = "SLO targets differ from PRD NFR-1..8."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.math["burn-fast-long"].threshold > 1.43 && aws_cloudwatch_metric_alarm.math["burn-fast-long"].threshold < 1.45 && aws_cloudwatch_metric_alarm.math["burn-slow-long"].threshold > 0.59 && aws_cloudwatch_metric_alarm.math["burn-slow-long"].threshold < 0.61
    error_message = "Burn-rate thresholds are not 14.4x and 6x of the 0.1 percent budget."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["api-latency"].threshold == 0.5 && aws_cloudwatch_metric_alarm.simple["api-latency"].extended_statistic == "p95" && aws_cloudwatch_metric_alarm.simple["slot-search-latency"].threshold == 1
    error_message = "Latency alarms do not use the approved targets."
  }
  assert {
    condition     = length(output.slo_table) == 6
    error_message = "SLO table rows changed."
  }
}

run "plan_thresholds_from_devops_plan_11_3" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["db-cpu"].threshold == 80 && aws_cloudwatch_metric_alarm.simple["db-cpu"].evaluation_periods == 10
    error_message = "DB CPU is 80 percent for 10 minutes."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["db-connections"].threshold == 420
    error_message = "Connections alarm is 70 percent of 600."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["db-storage"].threshold == 0.2 * 100 * 1073741824 && aws_cloudwatch_metric_alarm.simple["db-storage"].comparison_operator == "LessThanThreshold"
    error_message = "Free storage alarm is 20 percent."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["queue-oldest-job"].threshold == 300 && aws_cloudwatch_metric_alarm.simple["backup-stale"].evaluation_periods == 26 && aws_cloudwatch_metric_alarm.simple["backup-replica-lag"].threshold == 600 && aws_cloudwatch_metric_alarm.simple["audit-anchor-archive-late"].threshold == 900 && aws_cloudwatch_metric_alarm.simple["audit-anchor-archive-late"].treat_missing_data == "breaching"
    error_message = "Queue 5 min, backup 26 h and replica lag 600 s."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["cert-my"].threshold == 21
    error_message = "Certificate alarm is 21 days."
  }
  assert {
    condition     = length(aws_cloudwatch_composite_alarm.burn) == 2
    error_message = "Two multi-window burn alarms."
  }
}

run "backup_lag_alarm_inactive_until_first_replica_reports" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["backup-replica-lag"].actions_enabled == false && aws_cloudwatch_metric_alarm.simple["backup-replica-lag"].treat_missing_data == "breaching"
    error_message = "Replica lag alarm must start disabled and treat missing data as breaching."
  }
}

run "paging_claims_nothing_without_a_rota" {
  command = plan

  assert {
    condition     = output.paging_status.availability_claimed == false && output.paging_status.on_call_rota_named == false
    error_message = "Availability must not be claimed without a named rota (C-18)."
  }
}

run "vendor_criticality_routes_to_page_or_ticket" {
  command = plan

  assert {
    condition     = output.alarm_routes["t-integration-circuit-sms"] == "page" && output.alarm_routes["t-integration-circuit-video"] == "ticket" && output.alarm_routes["t-audit-anchor-mismatch"] == "security" && output.alarm_routes["t-audit-anchor-archive-late"] == "security" && output.alarm_routes["t-queue-dead-letter-growth"] == "page"
    error_message = "Vendor routing by criticality."
  }
}

run "canaries_are_read_only_and_cost_matches_plan" {
  command = plan

  assert {
    condition     = alltrue([for k, c in aws_synthetics_canary.read : startswith(c.run_config[0].environment_variables.TARGET_URL, "https://") && !strcontains(c.run_config[0].environment_variables.TARGET_URL, "?")])
    error_message = "Canaries are https GETs without query strings."
  }
  assert {
    condition     = output.canary_monthly_cost_usd.total > 165 && output.canary_monthly_cost_usd.total < 166
    error_message = "Canary cost differs from the DEVOPS-PLAN 11.4 table (2 x 51.84 + 6 x 10.37)."
  }
  assert {
    condition     = aws_synthetics_canary.read["my-shallow"].schedule[0].expression == "rate(1 minute)" && aws_synthetics_canary.read["www"].schedule[0].expression == "rate(5 minutes)"
    error_message = "Canary schedule."
  }
}

run "data_protection_policy_covers_every_log_group" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_log_data_protection_policy.app) == 2
    error_message = "Each application log group gets the policy."
  }
  assert {
    condition     = strcontains(output.data_protection_policy, "PHI-CANARY-[A-Z0-9]{8,}") && strcontains(output.data_protection_policy, "Deidentify") && strcontains(output.data_protection_policy, "Audit")
    error_message = "Policy must audit and de-identify, including the canary pattern."
  }
}

run "collector_allowlist_and_sidecar" {
  command = plan

  assert {
    condition     = strcontains(output.adot_collector_config, "\"allow_all_keys\": false") && strcontains(output.adot_collector_config, "\"http.route\"") && strcontains(output.adot_collector_config, "\"redaction\"")
    error_message = "Collector must run with an explicit key allowlist."
  }
  assert {
    condition     = output.adot_container_definition.essential == false && output.adot_container_definition.readonlyRootFilesystem == true
    error_message = "Sidecar must not be essential and must have a read-only filesystem."
  }
}

run "cloudfront_waf_alarm_needs_us_east_1" {
  command = plan
  variables {
    waf_web_acls = { t-cf = { scope = "CLOUDFRONT" } }
  }
  expect_failures = [aws_cloudwatch_metric_alarm.simple["waf-blocks-t-cf"]]
}

run "canary_url_with_query_rejected" {
  command = plan
  variables {
    canaries = { bad = { url = "https://my.example.test/?patient=1", kind = "shallow", every_minutes = 1, page_on_failure = true } }
  }
  expect_failures = [var.canaries]
}

run "canary_frequency_must_be_approved" {
  command = plan
  variables {
    canaries = { bad = { url = "https://my.example.test/healthz", kind = "shallow", every_minutes = 2, page_on_failure = true } }
  }
  expect_failures = [var.canaries]
}

run "write_canary_kind_rejected" {
  command = plan
  variables {
    canaries = { bad = { url = "https://my.example.test/book", kind = "write", every_minutes = 5, page_on_failure = false } }
  }
  expect_failures = [var.canaries]
}

run "tag_image_rejected" {
  command = plan
  variables {
    adot_image = "111111111111.dkr.ecr.us-east-2.amazonaws.com/adot:latest"
  }
  expect_failures = [var.adot_image]
}

run "second_instance_holds_only_non_core_alarms" {
  command = plan
  variables {
    enable_core            = false
    region                 = "us-east-1"
    waf_web_acls           = { t-cf = { scope = "CLOUDFRONT" } }
    canaries               = {}
    db_instance_identifier = ""
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.simple) == 1 && length(aws_cloudwatch_metric_alarm.math) == 0
    error_message = "enable_core = false creates only the WAF alarm."
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_event_rule.alert)) == toset(["cloudtrail-change", "root-login", "break-glass-use"])
    error_message = "The us-east-1 instance must hold the root-login, break-glass and CloudTrail-change rules (global events are recorded there)."
  }
}

run "primary_instance_keeps_security_rules" {
  command = plan

  assert {
    condition     = contains(keys(aws_cloudwatch_event_rule.alert), "root-login") && contains(keys(aws_cloudwatch_event_rule.alert), "guardduty-high")
    error_message = "The primary instance keeps its own security rules."
  }
}

run "canary_names_unique_and_within_limit" {
  command = plan
  variables {
    name = "ehr-production"
  }

  assert {
    condition     = length(distinct(values(local.canary_names))) == length(local.canary_names) && length(local.canary_names) == 8
    error_message = "Canary names must be unique for the eight plan canaries."
  }
  assert {
    condition     = alltrue([for k, n in local.canary_names : length(n) <= 21 && can(regex("^[a-z0-9_-]+$", n))])
    error_message = "Canary names must be at most 21 characters of lower-case letters, digits, hyphen and underscore."
  }
}

run "silent_emitter_alarms_breach_on_missing_data" {
  command = plan
  variables {
    app_metrics_heartbeat_enabled = true
  }

  assert {
    condition = alltrue([
      for k, a in aws_cloudwatch_metric_alarm.simple : a.treat_missing_data == "breaching" && a.actions_enabled
      if startswith(k, "metrics-silent-")
    ]) && length([for k, a in aws_cloudwatch_metric_alarm.simple : k if startswith(k, "metrics-silent-")]) == 4
    error_message = "Each application emitter needs a silent-emitter alarm that breaches on missing data."
  }
}

run "phi_alarm_uses_findings_metric_filter" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.simple["phi-in-logs"].metric_name == "PhiFindingEvents" && length(aws_cloudwatch_log_metric_filter.phi_findings) == 1
    error_message = "The PHI-in-logs alarm must read the metric produced from the findings log group."
  }
}

run "bare_module_with_no_inputs_plans" {
  command = plan
  variables {
    alb_arn_suffix            = ""
    target_group_arn_suffixes = {}
    db_instance_identifier    = ""
    log_group_names           = []
    certificate_arns          = {}
    waf_web_acls              = {}
    backup_vault_name         = ""
    recovery_region           = ""
    backup_replication_rules  = {}
    integration_vendors       = {}
    break_glass_role_arns     = []
    migration_task_family     = ""
    monthly_budget_usd        = null
    extra_budgets             = {}
    adot_image                = ""
    canary_artifacts_bucket   = ""
    canaries                  = {}
  }

  assert {
    condition     = output.adot_container_definition == null && length(aws_budgets_budget.monthly) == 0 && length(aws_synthetics_canary.read) == 0
    error_message = "Optional parts are off without their inputs."
  }
}
