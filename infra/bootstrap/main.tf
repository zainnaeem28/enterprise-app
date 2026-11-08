# Terraform state backend for the workload roots (one state object per account root).
# Versioned, SSE-KMS, TLS-only, no public access, replicated to the recovery
# Region. DEVOPS-PLAN 3.1 ("IaC state in tooling"), 7.5, ARCHITECTURE 9.4.

locals {
  tags = {
    Project   = "ehr-platform"
    ManagedBy = "opentofu"
    Root      = "bootstrap"
  }
}

module "state_key" {
  source = "../modules/kms"

  alias                = "tfstate"
  description          = "Terraform state (workload roots)"
  usage_principal_arns = var.state_access_role_arns
  service_principals   = ["s3.amazonaws.com"]
  tags                 = local.tags
}

module "state_key_recovery" {
  source    = "../modules/kms"
  providers = { aws = aws.recovery }

  alias                      = "tfstate-replica"
  description                = "Terraform state replica (recovery Region)"
  usage_principal_arns       = var.state_access_role_arns
  service_principals         = ["s3.amazonaws.com"]
  cross_account_decrypt_arns = [aws_iam_role.replication.arn]
  tags                       = local.tags
}

# ---- recovery-Region replica bucket ---------------------------------------

resource "aws_s3_bucket" "replica" {
  provider = aws.recovery
  bucket   = "${var.state_bucket_name}-replica"
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.state_key_recovery.key_arn
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
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_lifecycle_configuration" "replica" {
  provider = aws.recovery
  bucket   = aws_s3_bucket.replica.id
  rule {
    id     = "expire-noncurrent-state"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "replica_bucket" {
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
    sid       = "DenyOutsideOrganization"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.replica.arn, "${aws_s3_bucket.replica.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
  }
}

resource "aws_s3_bucket_policy" "replica" {
  provider   = aws.recovery
  bucket     = aws_s3_bucket.replica.id
  policy     = data.aws_iam_policy_document.replica_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.replica, aws_s3_bucket_replication_configuration.state]
}

# ---- primary state bucket --------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.state_key.key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

# Old state versions are kept 365 days (recoverable history), then expire.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-noncurrent-state"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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
    sid       = "DenyOutsideOrganization"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
    # S3 replication runs as a role in this account (inside the organisation), so no exemption is needed.
  }

  statement {
    sid       = "StateReadWriteForRootRoles"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = var.state_access_role_arns
    }
  }

  statement {
    sid       = "StateList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
    principals {
      type        = "AWS"
      identifiers = var.state_access_role_arns
    }
  }

  # Only the platform admin can change bucket-level configuration or purge versions.
  statement {
    sid    = "DenyAdministrationExceptPlatformAdmin"
    effect = "Deny"
    actions = [
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketVersioning",
      "s3:PutReplicationConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:DeleteObjectVersion",
    ]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
  depends_on = [
    aws_s3_bucket_public_access_block.state,
    aws_s3_bucket_versioning.state,
    aws_s3_bucket_server_side_encryption_configuration.state,
    aws_s3_bucket_lifecycle_configuration.state,
    aws_s3_bucket_replication_configuration.state,
  ]
}

# ---- replication -----------------------------------------------------------

data "aws_iam_policy_document" "replication_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "tfstate-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_trust.json
}

data "aws_iam_policy_document" "replication" {
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
  statement {
    actions   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
    resources = ["${aws_s3_bucket.replica.arn}/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [module.state_key.key_arn]
  }
  statement {
    actions   = ["kms:Encrypt", "kms:GenerateDataKey*"]
    resources = [module.state_key_recovery.key_arn]
  }
}

resource "aws_iam_role_policy" "replication" {
  name   = "tfstate-replication"
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}

resource "aws_s3_bucket_replication_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  role   = aws_iam_role.replication.arn

  rule {
    id     = "state-to-recovery"
    status = "Enabled"
    filter {}
    delete_marker_replication { status = "Enabled" }

    source_selection_criteria {
      sse_kms_encrypted_objects { status = "Enabled" }
    }

    destination {
      bucket        = aws_s3_bucket.replica.arn
      storage_class = "STANDARD"
      encryption_configuration {
        replica_kms_key_id = module.state_key_recovery.key_arn
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.state, aws_s3_bucket_versioning.replica]
}

# Applied last: the bucket policy denies administration to everyone but platform-admin,
# so every other bucket configuration is created before it can restrict the applier.
# The first apply must still be run as the platform-admin role (see README).

