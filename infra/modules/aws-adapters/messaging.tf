# E-mail (SES), SMS (End User Messaging) and malware scan (GuardDuty Malware Protection for S3) configuration.
# Not created here: SMS phone numbers / pools / sender IDs (a purchase plus carrier registration), the SES
# production-access request, DNS records for DKIM / SPF / DMARC, the SNS topic and event destination for
# bounces and complaints (the receipt route does not exist yet, AWS-ADAPTERS.md "Receipts"). Those are go-live items.

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.ses_domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = local.tags
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = "${var.env}-ehr-mail"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = local.tags
}

resource "aws_pinpointsmsvoicev2_configuration_set" "this" {
  name = "${var.env}-ehr-sms"
  tags = local.tags
}

# GuardDuty Malware Protection for S3 on the quarantine bucket. The plan tags each new object
# GuardDutyMalwareScanStatus; the worker's scan adapter only reads that tag (a missing tag is "pending",
# never "clean"). Object tag names and values are Unverified until a real scan (docs/GO-LIVE.md).
data "aws_iam_policy_document" "guardduty_assume" {
  statement {
    sid     = "GuardDutyMalwareProtection"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["malware-protection-plan.guardduty.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

data "aws_iam_policy_document" "guardduty" {
  statement {
    sid    = "ManagedEventBridgeRule"
    effect = "Allow"
    actions = [
      "events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets",
      "events:DescribeRule", "events:ListTargetsByRule",
    ]
    resources = ["arn:${local.partition}:events:${local.region}:${local.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"]
    condition {
      test     = "StringLike"
      variable = "events:ManagedBy"
      values   = ["malware-protection-plan.guardduty.amazonaws.com"]
    }
  }

  statement {
    sid       = "BucketNotificationsAndLocation"
    effect    = "Allow"
    actions   = ["s3:PutBucketNotification", "s3:GetBucketNotification", "s3:PutBucketOwnershipControls", "s3:GetBucketLocation", "s3:ListBucket"]
    resources = [local.docs_quarantine_arn]
  }

  statement {
    sid       = "ReadAndTagScannedObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging", "s3:GetObjectVersionTagging", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
    resources = ["${local.docs_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "ObjectKey"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "guardduty" {
  name               = local.guardduty_role_name
  description        = "GuardDuty Malware Protection for S3 on the ${var.env} quarantine bucket"
  assume_role_policy = data.aws_iam_policy_document.guardduty_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "guardduty" {
  name   = "malware-protection-quarantine"
  role   = aws_iam_role.guardduty.id
  policy = data.aws_iam_policy_document.guardduty.json
}

resource "aws_guardduty_malware_protection_plan" "quarantine" {
  role = aws_iam_role.guardduty.arn

  protected_resource {
    s3_bucket {
      bucket_name     = var.docs_quarantine_bucket_name
      object_prefixes = ["q/"]
    }
  }

  actions {
    tagging {
      status = "ENABLED"
    }
  }

  tags = local.tags

  depends_on = [aws_iam_role_policy.guardduty]
}
