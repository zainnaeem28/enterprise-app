# Everything the AWS adapters (docs/runbooks/AWS-ADAPTERS.md) need from the cloud, authored only, never applied
# here: the buckets the storage module does not make, the payload sealing key, SES / End User Messaging /
# GuardDuty Malware Protection configuration, the api / worker / execution roles on exact resources, and the
# environment the two services receive. IAM is written by the human platform-admin apply (DEVOPS-PLAN 7.5).

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  tags       = merge(var.tags, { Module = "aws-adapters" })
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition

  # Role names are fixed here so the ARNs are known without the roles existing. The storage module
  # (clean-bucket writer) and the archive module (anchor writers) take them as plain strings.
  api_role_name       = "${var.env}-ehr-api-task"
  worker_role_name    = "${var.env}-ehr-worker-task"
  execution_role_name = "${var.env}-ehr-task-execution"
  guardduty_role_name = "${var.env}-ehr-guardduty-s3-scan"
  role_arn_prefix     = "arn:${local.partition}:iam::${local.account_id}:role"

  docs_quarantine_arn = "arn:${local.partition}:s3:::${var.docs_quarantine_bucket_name}"
  docs_clean_arn      = "arn:${local.partition}:s3:::${var.docs_clean_bucket_name}"
  package_bucket_name = "${var.bucket_name_prefix}-privacy-packages"
  export_bucket_name  = "${var.bucket_name_prefix}-audit-exports"
  anchor_bucket_arn   = "arn:${local.partition}:s3:::${var.anchor_archive_bucket_name}"

  secret_arn_prefix = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${var.env}"
  # Region wildcard: one deny covers the home and the recovery Region (SC-2, HEAAA-870 D-4a).
  secret_arn_any_region = "arn:${local.partition}:secretsmanager:*:${local.account_id}:secret:${var.env}"
  ses_identity_arn      = "arn:${local.partition}:ses:${local.region}:${local.account_id}:identity/${var.ses_domain}"
  ses_config_arn        = "arn:${local.partition}:ses:${local.region}:${local.account_id}:configuration-set/${aws_sesv2_configuration_set.this.configuration_set_name}"
  sms_config_arn        = aws_pinpointsmsvoicev2_configuration_set.this.arn

  sms_enabled = var.sms_origination_identity_arn != null
}

# ---------------------------------------------------------------------------
# Payload sealing key (EHR_KMS_PAYLOAD_KEY_ID). The api seals, the worker opens; neither can do the other's
# half (SC-2, SC-3). The key policy denies it even if an identity policy later allows it, and every use must
# carry the ehr:ctx encryption context the application sets.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "payload_key" {
  statement {
    sid       = "AccountRootAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "ApiSealsOnly"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.api.arn]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["ehr:ctx"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContextKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "WorkerOpensOnly"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.worker.arn]
    }
  }

  statement {
    sid       = "ApiCannotOpen"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:ReEncrypt*", "kms:Encrypt"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.api.arn]
    }
  }

  statement {
    sid       = "WorkerCannotSeal"
    effect    = "Deny"
    actions   = ["kms:GenerateDataKey*", "kms:Encrypt", "kms:ReEncrypt*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.worker.arn]
    }
  }
}

resource "aws_kms_key" "payload" {
  description              = "${var.env} sealed integration payloads and secret-change requests (envelope data keys)"
  enable_key_rotation      = true
  rotation_period_in_days  = 365
  deletion_window_in_days  = 30
  multi_region             = var.payload_key_multi_region
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  policy                   = data.aws_iam_policy_document.payload_key.json
  tags                     = merge(local.tags, { Name = "${var.env}-payload" })
}

resource "aws_kms_alias" "payload" {
  name          = "alias/${var.env}-payload"
  target_key_id = aws_kms_key.payload.key_id
}

# ---------------------------------------------------------------------------
# Buckets the storage module does not make: privacy packages (presigned download) and audit exports.
# ---------------------------------------------------------------------------

locals {
  buckets = {
    packages = { name = local.package_bucket_name, expiry_days = var.package_expiry_days }
    exports  = { name = local.export_bucket_name, expiry_days = var.export_expiry_days }
  }
}

#trivy:ignore:AWS-0089 enabled through aws_s3_bucket_logging when access_log_bucket is set; the log bucket lives in another account
resource "aws_s3_bucket" "this" {
  for_each      = local.buckets
  bucket        = each.value.name
  force_destroy = var.force_destroy
  tags          = merge(local.tags, { Name = each.value.name })
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.data_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_logging" "this" {
  for_each      = var.access_log_bucket == null ? {} : local.buckets
  bucket        = aws_s3_bucket.this[each.key].id
  target_bucket = var.access_log_bucket
  target_prefix = "s3/${each.value.name}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = each.value.expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "bucket" {
  for_each = local.buckets

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this[each.key].arn, "${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyWritesNotEncryptedWithKms"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyWritesWithAnotherKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.data_kms_key_arn]
    }
  }

  # Only the worker (packages, exports) writes or deletes; the api only reads packages.
  statement {
    sid       = "OnlyWorkerWritesOrDeletes"
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = ["${local.role_arn_prefix}/${local.worker_role_name}"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each   = local.buckets
  bucket     = aws_s3_bucket.this[each.key].id
  policy     = data.aws_iam_policy_document.bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.this]
}
