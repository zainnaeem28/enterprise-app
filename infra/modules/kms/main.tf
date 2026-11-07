# Customer-managed KMS key with annual rotation. Key policy keeps the account
# root as administrator (IAM policies then govern), and grants usage only to
# the principals and AWS services passed in. DEVOPS-PLAN 3.1, 7.5; ARCHITECTURE 9.4.

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountRootAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = length(var.usage_principal_arns) > 0 ? [1] : []
    content {
      sid    = "UsagePrincipals"
      effect = "Allow"
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = var.usage_principal_arns
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.service_principals) > 0 ? [1] : []
    content {
      sid    = "ServiceUsageInThisAccount"
      effect = "Allow"
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = var.service_principals
      }
      condition {
        test     = "StringEquals"
        variable = var.service_source_org_id == null ? "aws:SourceAccount" : "aws:SourceOrgID"
        values   = [var.service_source_org_id == null ? local.account_id : var.service_source_org_id]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.cross_account_decrypt_arns) > 0 ? [1] : []
    content {
      sid    = "CrossAccountDecryptForReplication"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:ReEncrypt*",
      ]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = var.cross_account_decrypt_arns
      }
    }
  }
}

resource "aws_kms_key" "this" {
  description              = var.description
  enable_key_rotation      = true
  rotation_period_in_days  = 365
  deletion_window_in_days  = var.deletion_window_in_days
  multi_region             = var.multi_region
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  policy                   = data.aws_iam_policy_document.key.json

  tags = merge(var.tags, { Name = var.alias })
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.alias}"
  target_key_id = aws_kms_key.this.key_id
}
