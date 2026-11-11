# BackupReplicaLagSeconds publisher (DEVOPS-PLAN 11.3, DPR-15). RDS has no native lag metric for replicated automated backups.
# Role is limited to the one read API and PutMetricData in the application namespace. Unverified until the staging rehearsal.

locals {
  lag_enabled = var.enable_core && var.recovery_region != ""
}

data "archive_file" "backup_lag" {
  type        = "zip"
  output_path = "${path.module}/.out/backup_lag.zip"
  source {
    content  = file("${path.module}/lambda/backup_lag.py")
    filename = "backup_lag.py"
  }
}

data "aws_iam_policy_document" "lag_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lag" {
  # checkov:skip=CKV_AWS_356:rds:DescribeDBInstanceAutomatedBackups has no resource-level permission; PutMetricData is limited by the cloudwatch:namespace condition
  count = local.lag_enabled ? 1 : 0

  statement {
    sid       = "ReadReplicatedBackups"
    actions   = ["rds:DescribeDBInstanceAutomatedBackups"]
    resources = [var.db_replicated_backup_arn_pattern]
  }
  statement {
    sid       = "PublishLagMetric"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.app_metric_namespace]
    }
  }
  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lag[0].arn}:*"]
  }
}

resource "aws_cloudwatch_log_group" "lag" {
  # checkov:skip=CKV_AWS_338:Log retention is var.log_retention_days (90 days, owner ruling C item 2, counsel confirmation pending); the 1-year archive stage is described in infra/RETENTION.md
  count             = local.lag_enabled ? 1 : 0
  name              = "/aws/lambda/${var.name}-backup-lag"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_iam_role" "lag" {
  count              = local.lag_enabled ? 1 : 0
  name               = "${var.name}-backup-lag"
  assume_role_policy = data.aws_iam_policy_document.lag_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "lag" {
  count  = local.lag_enabled ? 1 : 0
  name   = "backup-lag"
  role   = aws_iam_role.lag[0].id
  policy = data.aws_iam_policy_document.lag[0].json
}

resource "aws_lambda_function" "lag" {
  # checkov:skip=CKV_AWS_117:Reads the public RDS and CloudWatch APIs only; a VPC would need NAT or endpoints for no isolation gain
  # checkov:skip=CKV_AWS_272:No code-signing configuration exists in this programme yet; the zip is built from this repository by the pipeline
  # checkov:skip=CKV_AWS_116:Scheduled every 5 minutes; a failed run is itself alarmed (BackupReplicaLookupFailed, missing data breaching)
  count                          = local.lag_enabled ? 1 : 0
  function_name                  = "${var.name}-backup-lag"
  role                           = aws_iam_role.lag[0].arn
  runtime                        = "python3.13"
  handler                        = "backup_lag.handler"
  filename                       = data.archive_file.backup_lag.output_path
  source_code_hash               = data.archive_file.backup_lag.output_base64sha256
  timeout                        = 30
  memory_size                    = 128
  reserved_concurrent_executions = 1
  kms_key_arn                    = var.kms_key_arn

  environment {
    variables = {
      RECOVERY_REGION  = var.recovery_region
      METRIC_NAMESPACE = var.app_metric_namespace
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lag]
  tags       = var.tags
}

resource "aws_cloudwatch_event_rule" "lag" {
  count               = local.lag_enabled ? 1 : 0
  name                = "${var.name}-backup-lag"
  description         = "Every 5 minutes: publish BackupReplicaLagSeconds."
  schedule_expression = "rate(5 minutes)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "lag" {
  count = local.lag_enabled ? 1 : 0
  rule  = aws_cloudwatch_event_rule.lag[0].name
  arn   = aws_lambda_function.lag[0].arn
}

resource "aws_lambda_permission" "lag" {
  count         = local.lag_enabled ? 1 : 0
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lag[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.lag[0].arn
}
