# Document buckets: quarantine (uploads, scanned, short-lived) and clean
# (scan-passed, versioned, replicated to the recovery Region with RTC).
# DEVOPS-PLAN 3.2, 10.1; ARCHITECTURE 9.4. Authored only, never applied here.

locals {
  quarantine_name = "${var.name_prefix}-docs-quarantine"
  clean_name      = "${var.name_prefix}-docs-clean"
  replica_name    = "${var.name_prefix}-docs-clean-replica"
  buckets = {
    quarantine = aws_s3_bucket.quarantine.id
    clean      = aws_s3_bucket.clean.id
  }
}

# ---------- quarantine ----------

#trivy:ignore:AWS-0089 access logging is optional here (access_log_bucket); object-level activity is audited by the application and CloudTrail data events
resource "aws_s3_bucket" "quarantine" {
  bucket        = local.quarantine_name
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = local.quarantine_name, DataClass = "quarantine" })
}

# ---------- clean ----------

#trivy:ignore:AWS-0089 access logging is optional here (access_log_bucket); object-level activity is audited by the application and CloudTrail data events
resource "aws_s3_bucket" "clean" {
  bucket        = local.clean_name
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = local.clean_name, DataClass = "clean" })
}

resource "aws_s3_bucket_versioning" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "clean" {
  bucket = aws_s3_bucket.clean.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "quarantine" {
  bucket                  = aws_s3_bucket.quarantine.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "clean" {
  bucket = aws_s3_bucket.clean.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "clean" {
  bucket                  = aws_s3_bucket.clean.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets
  bucket   = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_logging" "this" {
  for_each      = var.access_log_bucket == null ? {} : local.buckets
  bucket        = each.value
  target_bucket = var.access_log_bucket
  target_prefix = "s3-access/${each.key}/"
}

# The scan pipeline reacts to uploads through EventBridge.
resource "aws_s3_bucket_notification" "quarantine" {
  bucket      = aws_s3_bucket.quarantine.id
  eventbridge = true
}

resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id
  rule {
    id     = "expire-unprocessed"
    status = "Enabled"
    filter {}
    expiration {
      days = var.quarantine_expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  depends_on = [aws_s3_bucket_versioning.quarantine]
}

resource "aws_s3_bucket_lifecycle_configuration" "clean" {
  bucket = aws_s3_bucket.clean.id
  rule {
    id     = "noncurrent-retention"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.clean]
}

# ---------- bucket policies ----------

data "aws_iam_policy_document" "quarantine" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.quarantine.arn, "${aws_s3_bucket.quarantine.arn}/*"]
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
    sid       = "DenyUnencryptedWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.quarantine.arn}/*"]
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
}

data "aws_iam_policy_document" "clean" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.clean.arn, "${aws_s3_bucket.clean.arn}/*"]
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
    sid       = "DenyUnencryptedWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.clean.arn}/*"]
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

  dynamic "statement" {
    for_each = length(var.clean_writer_principal_arns) > 0 ? [1] : []
    content {
      sid       = "OnlyPromotionRoleWritesClean"
      effect    = "Deny"
      actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = ["${aws_s3_bucket.clean.arn}/*"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.clean_writer_principal_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "quarantine" {
  bucket     = aws_s3_bucket.quarantine.id
  policy     = data.aws_iam_policy_document.quarantine.json
  depends_on = [aws_s3_bucket_public_access_block.quarantine]
}

resource "aws_s3_bucket_policy" "clean" {
  bucket     = aws_s3_bucket.clean.id
  policy     = data.aws_iam_policy_document.clean.json
  depends_on = [aws_s3_bucket_public_access_block.clean]

  lifecycle {
    precondition {
      condition     = length(var.clean_writer_principal_arns) > 0 || var.allow_unrestricted_clean_writers
      error_message = "clean_writer_principal_arns must name the scan-promotion role, or set allow_unrestricted_clean_writers for a throwaway environment."
    }
  }
}

# ---------- cross-Region replication of the clean bucket (RTC) ----------

#trivy:ignore:AWS-0089 replica is write-only for the replication role; CloudTrail data events cover it
resource "aws_s3_bucket" "replica" {
  count         = var.replication_enabled ? 1 : 0
  provider      = aws.recovery
  bucket        = local.replica_name
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = local.replica_name, DataClass = "clean-replica" })
}

resource "aws_s3_bucket_versioning" "replica" {
  count    = var.replication_enabled ? 1 : 0
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  count    = var.replication_enabled ? 1 : 0
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.replica_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "replica" {
  count                   = var.replication_enabled ? 1 : 0
  provider                = aws.recovery
  bucket                  = aws_s3_bucket.replica[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "replica" {
  count    = var.replication_enabled ? 1 : 0
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "replica" {
  count = var.replication_enabled ? 1 : 0
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.replica[0].arn, "${aws_s3_bucket.replica[0].arn}/*"]
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

  # Scan promotion writes here during a failover (replication itself uses s3:ReplicateObject, which these denies do not touch).
  statement {
    sid       = "DenyUnencryptedWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.replica[0].arn}/*"]
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

  dynamic "statement" {
    for_each = length(var.clean_writer_principal_arns) > 0 ? [1] : []
    content {
      sid       = "OnlyPromotionRoleWritesClean"
      effect    = "Deny"
      actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = ["${aws_s3_bucket.replica[0].arn}/*"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.clean_writer_principal_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "replica" {
  count      = var.replication_enabled ? 1 : 0
  provider   = aws.recovery
  bucket     = aws_s3_bucket.replica[0].id
  policy     = data.aws_iam_policy_document.replica[0].json
  depends_on = [aws_s3_bucket_public_access_block.replica]
}

data "aws_iam_policy_document" "replication_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "replication" {
  count = var.replication_enabled ? 1 : 0

  statement {
    sid       = "ReadSourceConfiguration"
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.clean.arn]
  }
  statement {
    sid = "ReadSourceObjects"
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.clean.arn}/*"]
  }
  statement {
    sid = "WriteReplica"
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["${aws_s3_bucket.replica[0].arn}/*"]
  }
  statement {
    sid       = "DecryptSource"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
  statement {
    sid       = "EncryptReplica"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.replica_kms_key_arn]
  }
}

resource "aws_iam_role" "replication" {
  count              = var.replication_enabled ? 1 : 0
  name               = "${var.name_prefix}-docs-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "replication" {
  count  = var.replication_enabled ? 1 : 0
  name   = "replicate-clean-documents"
  role   = aws_iam_role.replication[0].id
  policy = data.aws_iam_policy_document.replication[0].json
}

resource "aws_s3_bucket_replication_configuration" "clean" {
  count  = var.replication_enabled ? 1 : 0
  bucket = aws_s3_bucket.clean.id
  role   = aws_iam_role.replication[0].arn

  rule {
    id       = "clean-to-recovery"
    status   = "Enabled"
    priority = 1

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket        = aws_s3_bucket.replica[0].arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = var.replica_kms_key_arn
      }

      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.clean,
    aws_s3_bucket_versioning.replica,
  ]
}
