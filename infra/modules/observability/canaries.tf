# Read-only synthetic checks (DEVOPS-PLAN 11.4). Real-traffic SLIs carry the SLO; canaries confirm reachability,
# certificates and DNS. Every canary here is a GET: the module has no input or code path that writes data, so
# production writes stay off until DEVOPS-PLAN 16 item 12 (owner, compliance) is decided. Staging write journeys belong to the QA harness.

locals {
  canaries_enabled = var.enable_core && var.canary_artifacts_bucket != "" ? var.canaries : {}
  # Names are limited to 21 characters, lower-case, digits, hyphen, underscore.
  # Unique by construction: a readable prefix of the name plus an 8-character hash of "<name>/<key>" (21 = 12 + 1 + 8).
  canary_names = { for k, v in local.canaries_enabled : k => "${substr(replace(lower(var.name), "/[^a-z0-9_-]/", "-"), 0, 12)}-${substr(sha256("${var.name}/${k}"), 0, 8)}" }


  canary_runs_per_month = { for k, v in var.canaries : k => (60 / v.every_minutes) * 24 * 30 }
  canary_cost_usd       = { for k, n in local.canary_runs_per_month : k => n * var.canary_price_per_run_usd }
}

data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/.out/canary.zip"
  source {
    content  = file("${path.module}/canary/index.js")
    filename = "nodejs/node_modules/index.js"
  }
}

data "aws_iam_policy_document" "canary_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "canary" {
  statement {
    sid       = "WriteArtifacts"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.canary_artifacts_bucket}/canary/*"]
  }
  statement {
    sid       = "LocateBucket"
    actions   = ["s3:GetBucketLocation"]
    resources = ["arn:aws:s3:::${var.canary_artifacts_bucket}"]
  }
  statement {
    sid       = "ArtifactKey"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [var.kms_key_arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
    resources = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/cwsyn-*"]
  }
  statement {
    sid       = "Metrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
}

resource "aws_iam_role" "canary" {
  count              = length(local.canaries_enabled) > 0 ? 1 : 0
  name               = "${var.name}-canary"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "canary" {
  count  = length(aws_iam_role.canary)
  name   = "canary"
  role   = aws_iam_role.canary[0].id
  policy = data.aws_iam_policy_document.canary.json
}

resource "aws_synthetics_canary" "read" {
  for_each             = local.canaries_enabled
  name                 = local.canary_names[each.key]
  artifact_s3_location = "s3://${var.canary_artifacts_bucket}/canary/${each.key}/"
  execution_role_arn   = aws_iam_role.canary[0].arn
  handler              = "index.handler"
  zip_file             = data.archive_file.canary.output_path
  runtime_version      = var.canary_runtime_version
  start_canary         = true

  schedule {
    expression = "rate(${each.value.every_minutes} ${each.value.every_minutes == 1 ? "minute" : "minutes"})"
  }

  run_config {
    timeout_in_seconds = 60
    active_tracing     = false
    environment_variables = {
      TARGET_URL       = each.value.url
      KIND             = each.value.kind
      MIN_CERT_DAYS    = tostring(var.canary_min_cert_days)
      RELEASE_JSON_URL = each.value.release_json_url
    }
  }

  success_retention_period = 7
  failure_retention_period = 14
  tags                     = merge(var.tags, { AlertCatalogId = "synthetic_failed" })
}
