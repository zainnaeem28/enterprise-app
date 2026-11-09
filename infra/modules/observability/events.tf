# Event-driven alerts: security events, migration/deployment failures, RDS events, cost budgets.
# Targets receive a reduced message (type, time, region, account, event id, catalogue text), never the raw event:
# ECS task events can carry container overrides, which must not be mailed.

locals {
  break_glass = length(var.break_glass_role_arns) > 0
  migration   = var.migration_task_family != ""
  ct_trail    = "AWS API Call via CloudTrail"
  # Root console sign-in and global-endpoint STS events are recorded by CloudTrail in us-east-1, whatever Region the
  # workload runs in. These three rules therefore also exist in the us-east-1 instance (enable_core = false).
  global_events = var.region == "us-east-1"
  cluster_arn   = var.ecs_cluster_name == "" ? [] : ["arn:aws:ecs:${var.region}:${var.account_id}:cluster/${var.ecs_cluster_name}"]

  event_rules = {
    for k, v in {
      guardduty-high = {
        enabled = local.core, catalog = "guardduty_high", route = "security"
        pattern = { source = ["aws.guardduty"], "detail-type" = ["GuardDuty Finding"], detail = { severity = [{ numeric = [">=", 7] }] } }
      }
      cloudtrail-change = {
        enabled = local.core || local.global_events, catalog = "cloudtrail_change", route = "security"
        pattern = {
          source = ["aws.cloudtrail"], "detail-type" = [local.ct_trail]
          detail = { eventSource = ["cloudtrail.amazonaws.com"], eventName = ["StopLogging", "DeleteTrail", "UpdateTrail", "PutEventSelectors", "PutInsightSelectors"] }
        }
      }
      root-login = {
        enabled = local.core || local.global_events, catalog = "root_login", route = "security"
        pattern = { source = ["aws.signin"], "detail-type" = ["AWS Console Sign In via CloudTrail"], detail = { userIdentity = { type = ["Root"] } } }
      }
      break-glass-use = {
        enabled = (local.core || local.global_events) && local.break_glass, catalog = "break_glass_use", route = "security"
        pattern = {
          source = ["aws.sts"], "detail-type" = [local.ct_trail]
          detail = { eventSource = ["sts.amazonaws.com"], eventName = ["AssumeRole"], requestParameters = { roleArn = var.break_glass_role_arns } }
        }
      }
      migration-failed = {
        enabled = local.core && local.migration, catalog = "deployment_migration_failed", route = "page"
        pattern = {
          source = ["aws.ecs"], "detail-type" = ["ECS Task State Change"]
          detail = merge({ lastStatus = ["STOPPED"], taskDefinitionArn = [{ wildcard = "*:task-definition/${var.migration_task_family}:*" }], containers = { exitCode = [{ "anything-but" = 0 }] } }, length(local.cluster_arn) == 0 ? {} : { clusterArn = local.cluster_arn })
        }
      }
      deployment-failed = {
        enabled = local.core, catalog = "deployment_failed", route = "page"
        pattern = { source = ["aws.ecs"], "detail-type" = ["ECS Deployment State Change"], detail = { eventType = ["ERROR"] }, resources = [{ wildcard = "arn:aws:ecs:${var.region}:${var.account_id}:service/${var.ecs_cluster_name == "" ? "*" : var.ecs_cluster_name}/*" }] }
      }
    } : k => v if v.enabled
  }
}

resource "aws_cloudwatch_event_rule" "alert" {
  for_each      = local.event_rules
  name          = "${var.name}-${each.key}"
  description   = local.catalog_text[each.value.catalog]
  event_pattern = jsonencode(each.value.pattern)
  tags          = merge(var.tags, { AlertCatalogId = each.value.catalog })
}

resource "aws_cloudwatch_event_target" "alert" {
  for_each = local.event_rules
  rule     = aws_cloudwatch_event_rule.alert[each.key].name
  arn      = local.topic_arn[each.value.route]

  input_transformer {
    input_paths = {
      id         = "$.id"
      detailType = "$.detail-type"
      time       = "$.time"
      region     = "$.region"
      account    = "$.account"
    }
    input_template = jsonencode("${local.catalog_text[each.value.catalog]} | Event <detailType> <id> at <time>, account <account>, region <region>")
  }
}

resource "aws_db_event_subscription" "db" {
  count       = local.have_db ? 1 : 0
  name        = "${var.name}-db-events"
  sns_topic   = aws_sns_topic.route["page"].arn
  source_type = "db-instance"
  source_ids  = [var.db_instance_identifier]
  event_categories = [
    "availability",
    "failover",
    "failure",
    "low storage",
    "recovery",
  ]
  tags = merge(var.tags, { AlertCatalogId = "db_events" })
}

# Cost budgets (DEVOPS-PLAN 12, 13). Amounts are owner inputs; nothing here chooses them.
locals {
  budgets = merge(
    var.monthly_budget_usd == null ? {} : { total = { limit_usd = var.monthly_budget_usd, cost_filters = {} } },
    var.extra_budgets,
  )
}

resource "aws_budgets_budget" "monthly" {
  for_each     = local.core ? local.budgets : {}
  name         = "${var.name}-${each.key}"
  budget_type  = "COST"
  limit_amount = tostring(each.value.limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = each.value.cost_filters
    content {
      name   = cost_filter.key
      values = cost_filter.value
    }
  }

  dynamic "notification" {
    for_each = [
      { threshold = 50, type = "ACTUAL" },
      { threshold = 80, type = "ACTUAL" },
      { threshold = 100, type = "ACTUAL" },
      { threshold = 100, type = "FORECASTED" },
    ]
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value.threshold
      threshold_type            = "PERCENTAGE"
      notification_type         = notification.value.type
      subscriber_sns_topic_arns = [aws_sns_topic.route["ticket"].arn]
    }
  }

  tags = merge(var.tags, { AlertCatalogId = "cost_budget" })
}
