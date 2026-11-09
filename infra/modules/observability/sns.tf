# Alert routes. Three topics: page, ticket, security. Delivery is SNS email to named people until the owner
# chooses a rota and paging service (D-29, C-18); no paid service is selected here.

locals {
  topics = {
    page     = { endpoints = var.page_email_endpoints }
    ticket   = { endpoints = var.ticket_email_endpoints }
    security = { endpoints = var.security_email_endpoints }
  }
  subscriptions = merge([
    for t, v in local.topics : {
      for e in v.endpoints : "${t}:${e}" => { topic = t, endpoint = e }
    }
  ]...)
}

resource "aws_sns_topic" "route" {
  for_each          = local.topics
  name              = "${var.name}-alerts-${each.key}"
  kms_master_key_id = var.kms_key_arn
  tags              = merge(var.tags, { Name = "${var.name}-alerts-${each.key}" })
}

data "aws_iam_policy_document" "topic" {
  for_each = local.topics

  statement {
    sid       = "PublishFromMonitoringServices"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.route[each.key].arn]
    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
        "budgets.amazonaws.com",
        "rds.amazonaws.com",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "route" {
  for_each = local.topics
  arn      = aws_sns_topic.route[each.key].arn
  policy   = data.aws_iam_policy_document.topic[each.key].json
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = local.subscriptions
  topic_arn = aws_sns_topic.route[each.value.topic].arn
  protocol  = "email"
  endpoint  = each.value.endpoint
}
