# Log-archive account data: Object Lock audit archive (compliance mode,
# replicated with its lock to the recovery Region) and vault-locked AWS Backup
# vaults that receive database backup copies from the production account.
# DEVOPS-PLAN 10.1; ARCHITECTURE 9.4, SEC-D-17. Authored only, never applied here.

locals {
  archive_name = "${var.name_prefix}-audit-archive"
  replica_name = "${var.name_prefix}-audit-archive-replica"
  # Actions that remove data or weaken retention; denied to everyone.
  destructive_actions = [
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:DeleteBucket",
    "s3:DeleteBucketPolicy",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketObjectLockConfiguration",
    "s3:PutObjectRetention",
    "s3:BypassGovernanceRetention",
  ]
}

# ---------- audit archive (primary Region) ----------

#trivy:ignore:AWS-0089 object access is recorded by CloudTrail data events in this account; a log bucket for the archive would itself need Object Lock
resource "aws_s3_bucket" "archive" {
  bucket              = local.archive_name
  object_lock_enabled = true
  force_destroy       = var.force_destroy
  tags                = merge(var.tags, { Name = local.archive_name, DataClass = "audit-archive" })
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.archive]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "archive" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
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

  # Nobody, including the account's administrators and the production roles,
  # can delete archive objects or loosen retention through this bucket.
  statement {
    sid       = "DenyDeleteAndRetentionChanges"
    effect    = "Deny"
    actions   = local.destructive_actions
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "DenyUnencryptedWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.archive.arn}/*"]
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
    sid       = "AllowWritersFromOrganisation"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = var.writer_principal_arns
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
  }

  dynamic "statement" {
    for_each = length(var.reader_principal_arns) > 0 ? [1] : []
    content {
      sid       = "AllowReaders"
      effect    = "Allow"
      actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention", "s3:ListBucket", "s3:GetBucketLocation"]
      resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
      principals {
        type        = "AWS"
        identifiers = var.reader_principal_arns
      }
      condition {
        test     = "StringEquals"
        variable = "aws:PrincipalOrgID"
        values   = [var.organization_id]
      }
    }
  }

  # Legal holds are the only retention change allowed, and only by named roles.
  statement {
    sid       = "DenyLegalHoldExceptNamedRoles"
    effect    = "Deny"
    actions   = ["s3:PutObjectLegalHold"]
    resources = ["${aws_s3_bucket.archive.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = length(var.legal_hold_principal_arns) > 0 ? var.legal_hold_principal_arns : ["arn:aws:iam::000000000000:role/nobody"]
    }
  }
}

resource "aws_s3_bucket_policy" "archive" {
  bucket     = aws_s3_bucket.archive.id
  policy     = data.aws_iam_policy_document.archive.json
  depends_on = [aws_s3_bucket_public_access_block.archive]
}

# ---------- audit archive replica (recovery Region, Object Lock also on) ----------

#trivy:ignore:AWS-0089 object access is recorded by CloudTrail data events in this account
resource "aws_s3_bucket" "replica" {
  provider            = aws.recovery
  bucket              = local.replica_name
  object_lock_enabled = true
  force_destroy       = var.force_destroy
  tags                = merge(var.tags, { Name = local.replica_name, DataClass = "audit-archive-replica" })
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.replica]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.replica_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "replica" {
  provider                = aws.recovery
  bucket                  = aws_s3_bucket.replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "replica" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.replica.arn, "${aws_s3_bucket.replica.arn}/*"]
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
    sid       = "DenyDeleteAndRetentionChanges"
    effect    = "Deny"
    actions   = local.destructive_actions
    resources = [aws_s3_bucket.replica.arn, "${aws_s3_bucket.replica.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.replication.arn]
    }
  }

  # Lets the replication role (not production roles) set retention on replicas.
  statement {
    sid    = "AllowReplicationRole"
    effect = "Allow"
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateTags",
      "s3:ObjectOwnerOverrideToBucketOwner",
    ]
    resources = ["${aws_s3_bucket.replica.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.replication.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "replica" {
  provider   = aws.recovery
  bucket     = aws_s3_bucket.replica.id
  policy     = data.aws_iam_policy_document.replica.json
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
  statement {
    sid       = "ReadSourceConfiguration"
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket", "s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging", "s3:GetObjectRetention", "s3:GetObjectLegalHold"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
  }
  statement {
    sid       = "WriteReplica"
    actions   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags", "s3:ObjectOwnerOverrideToBucketOwner"]
    resources = ["${aws_s3_bucket.replica.arn}/*"]
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
  name               = "${var.name_prefix}-audit-archive-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "replication" {
  name   = "replicate-audit-archive"
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}

resource "aws_s3_bucket_replication_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  role   = aws_iam_role.replication.arn

  rule {
    id       = "archive-to-recovery"
    status   = "Enabled"
    priority = 1
    filter {}

    # Deletes are never replicated; there should be none.
    delete_marker_replication {
      status = "Disabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket        = aws_s3_bucket.replica.arn
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
    aws_s3_bucket_versioning.archive,
    aws_s3_bucket_versioning.replica,
    aws_s3_bucket_object_lock_configuration.archive,
    aws_s3_bucket_object_lock_configuration.replica,
  ]
}

# ---------- backup vaults (vault lock) ----------

data "aws_iam_policy_document" "vault_primary" {
  statement {
    sid       = "AllowCopyFromOrganisation"
    effect    = "Allow"
    actions   = ["backup:CopyIntoBackupVault"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
  }

  statement {
    sid    = "DenyDeleteRecoveryPoints"
    effect = "Deny"
    actions = [
      "backup:DeleteRecoveryPoint",
      "backup:UpdateRecoveryPointLifecycle",
      "backup:PutBackupVaultAccessPolicy",
      "backup:DeleteBackupVaultAccessPolicy",
      "backup:DeleteBackupVault",
    ]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_backup_vault" "primary" {
  name        = "${var.name_prefix}-db-vault"
  kms_key_arn = var.kms_key_arn
  tags        = var.tags
}

resource "aws_backup_vault_policy" "primary" {
  backup_vault_name = aws_backup_vault.primary.name
  policy            = data.aws_iam_policy_document.vault_primary.json
}

resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name   = aws_backup_vault.primary.name
  min_retention_days  = var.vault_min_retention_days
  max_retention_days  = var.vault_max_retention_days
  changeable_for_days = var.vault_lock_changeable_for_days
}

resource "aws_backup_vault" "recovery" {
  count       = var.recovery_vault_enabled ? 1 : 0
  provider    = aws.recovery
  name        = "${var.name_prefix}-db-vault-recovery"
  kms_key_arn = var.replica_kms_key_arn
  tags        = var.tags
}

data "aws_iam_policy_document" "vault_recovery" {
  count = var.recovery_vault_enabled ? 1 : 0
  statement {
    sid       = "AllowCopyFromOrganisation"
    effect    = "Allow"
    actions   = ["backup:CopyIntoBackupVault"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
  }

  statement {
    sid    = "DenyDeleteRecoveryPoints"
    effect = "Deny"
    actions = [
      "backup:DeleteRecoveryPoint",
      "backup:UpdateRecoveryPointLifecycle",
      "backup:PutBackupVaultAccessPolicy",
      "backup:DeleteBackupVaultAccessPolicy",
      "backup:DeleteBackupVault",
    ]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_backup_vault_policy" "recovery" {
  count             = var.recovery_vault_enabled ? 1 : 0
  provider          = aws.recovery
  backup_vault_name = aws_backup_vault.recovery[0].name
  policy            = data.aws_iam_policy_document.vault_recovery[0].json
}

resource "aws_backup_vault_lock_configuration" "recovery" {
  count               = var.recovery_vault_enabled ? 1 : 0
  provider            = aws.recovery
  backup_vault_name   = aws_backup_vault.recovery[0].name
  min_retention_days  = var.vault_min_retention_days
  max_retention_days  = var.vault_max_retention_days
  changeable_for_days = var.vault_lock_changeable_for_days
}
