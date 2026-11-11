# Delivery receipts (INT-N2): SES configuration-set event destination and the End User Messaging SMS topic (its event destination is a CLI step, below), each with its own
# SNS topic, each topic with an HTTPS subscription to the API route `POST /webhooks/sns/receipts` (apps/api, integrations-host).
# Off unless `receipt_endpoint_url` is set. The route verifies every message itself (SNS signature version 2, certificate host pinned to
# sns.<region>.amazonaws.com, TopicArn allowlist), so nothing here relies on the subscription being private. The route's own configuration
# (region, topic ARN -> channel) is emitted in `api_environment` from these resources.
#
# Static only: `tofu validate` / `tofu test` with mock providers. Not applied, no AWS call: the event-type names, the topic policy
# conditions and the subscription confirmation handshake are unverified until a real account exists (docs/GO-LIVE.md).
# After the first apply each subscription stays PendingConfirmation until the running API answers SNS's SubscriptionConfirmation.

locals {
  receipts_enabled     = var.receipt_endpoint_url != null
  receipts_sms_enabled = local.receipts_enabled && local.sms_enabled
  ses_config_set_arn   = "arn:${local.partition}:ses:${local.region}:${local.account_id}:configuration-set/${aws_sesv2_configuration_set.this.configuration_set_name}"
  sms_config_set_arn   = "arn:${local.partition}:sms-voice:${local.region}:${local.account_id}:configuration-set/${aws_pinpointsmsvoicev2_configuration_set.this.name}"

  receipt_topics = merge(
    local.receipts_enabled ? { email = { name = "${var.env}-ehr-ses-events", principal = "ses.amazonaws.com", source_arn = local.ses_config_set_arn } } : {},
    local.receipts_sms_enabled ? { sms = { name = "${var.env}-ehr-sms-events", principal = "sms-voice.amazonaws.com", source_arn = local.sms_config_set_arn } } : {},
  )
}

# The topics carry bounce and complaint events (recipient addresses): encrypted with a key of their own, usable by the two publishing services
# only for this account.
data "aws_iam_policy_document" "receipts_key" {
  count = local.receipts_enabled ? 1 : 0

  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "PublishingServices"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = distinct([for t in values(local.receipt_topics) : t.principal])
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "receipts" {
  count = local.receipts_enabled ? 1 : 0

  description             = "${var.env} delivery-receipt SNS topics"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.receipts_key[0].json
  tags                    = local.tags
}

resource "aws_kms_alias" "receipts" {
  count = local.receipts_enabled ? 1 : 0

  name          = "alias/${var.env}-ehr-receipts"
  target_key_id = aws_kms_key.receipts[0].key_id
}

resource "aws_sns_topic" "receipts" {
  for_each = local.receipt_topics

  name              = each.value.name
  kms_master_key_id = aws_kms_key.receipts[0].arn
  tags              = local.tags
}

data "aws_iam_policy_document" "receipts_topic" {
  for_each = local.receipt_topics

  statement {
    sid       = "PublishFromThisConfigurationSetOnly"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.receipts[each.key].arn]
    principals {
      type        = "Service"
      identifiers = [each.value.principal]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.source_arn]
    }
  }
}

resource "aws_sns_topic_policy" "receipts" {
  for_each = local.receipt_topics

  arn    = aws_sns_topic.receipts[each.key].arn
  policy = data.aws_iam_policy_document.receipts_topic[each.key].json
}

# SES: delivery, bounce and complaint events of every message sent with the configuration set (the worker sets EHR_SES_CONFIGURATION_SET).
resource "aws_sesv2_configuration_set_event_destination" "receipts" {
  count = local.receipts_enabled ? 1 : 0

  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "${var.env}-ehr-receipts"

  event_destination {
    enabled              = true
    matching_event_types = ["DELIVERY", "BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.receipts["email"].arn
    }
  }

  depends_on = [aws_sns_topic_policy.receipts]
}

# SMS: NOT in IaC. The pinned provider (hashicorp/aws ~> 5.80) has no resource for an End User Messaging SMS event destination
# (checked: `aws_pinpointsmsvoicev2_event_destination` is not in its schema; only the configuration set, opt-out list and phone number are).
# The topic, its policy and the subscription below exist; the destination is created once with the CLI step in the runbook
# (docs/runbooks/AWS-ADAPTERS.md "Receipts"), listing the final states the API maps (receipt-events.ts). It moves into IaC with a provider
# upgrade that has the resource.

# HTTPS subscription. The envelope must stay intact (the API verifies its signature), so raw message delivery is off. The API confirms
# the subscription itself; retries stay inside the API's accepted message age (EHR_SNS_RECEIPT_MAX_AGE_SECONDS, default 3600).
resource "aws_sns_topic_subscription" "receipts" {
  for_each = local.receipt_topics

  topic_arn              = aws_sns_topic.receipts[each.key].arn
  protocol               = "https"
  endpoint               = var.receipt_endpoint_url
  endpoint_auto_confirms = false
  raw_message_delivery   = false

  delivery_policy = jsonencode({
    healthyRetryPolicy = {
      numRetries         = 10
      minDelayTarget     = 20
      maxDelayTarget     = 300
      numNoDelayRetries  = 0
      numMinDelayRetries = 0
      numMaxDelayRetries = 0
      backoffFunction    = "exponential"
    }
  })
}

output "receipt_topic_arns" {
  description = "Delivery-receipt SNS topic ARNs by channel (email, sms). Empty when receipt_endpoint_url is null."
  value       = { for k, t in aws_sns_topic.receipts : k => t.arn }
}
