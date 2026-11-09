# Secret containers only. Values are never set here, never read here and never
# appear in state: there is no aws_secretsmanager_secret_version resource and no
# secret_string. DEVOPS-PLAN 7.2 (secret rows), 7.5 (detection); BD-11.

locals {
  names = { for k, s in var.secrets : k => "${var.env}/${k}" }

  # aws:PrincipalArn is the role ARN for assumed-role sessions.
  allowed_readers = { for k, s in var.secrets : k => distinct(concat(s.readers, s.writers, var.break_glass_role_arns, compact([]))) }
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = var.secrets
  name                    = local.names[each.key]
  description             = each.value.description
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days

  dynamic "replica" {
    for_each = var.recovery_region == null ? [] : [var.recovery_region]
    content {
      region     = replica.value
      kms_key_id = var.replica_kms_key_arn
    }
  }

  tags = merge(var.tags, { SecretPath = each.key })

  lifecycle {
    precondition {
      condition     = var.recovery_region == null || var.replica_kms_key_arn != null
      error_message = "replica_kms_key_arn is required when recovery_region is set."
    }
  }
}

resource "aws_secretsmanager_secret_policy" "this" {
  for_each   = var.secrets
  secret_arn = aws_secretsmanager_secret.this[each.key].arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "ReadersOnly"
          Effect    = "Allow"
          Principal = { AWS = each.value.readers }
          Action    = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
          Resource  = "*"
        },
        {
          Sid       = "TlsOnly"
          Effect    = "Deny"
          Principal = "*"
          Action    = "secretsmanager:*"
          Resource  = "*"
          Condition = { Bool = { "aws:SecureTransport" = "false" } }
        },
        {
          Sid       = "OrganisationOnly"
          Effect    = "Deny"
          Principal = "*"
          Action    = "secretsmanager:*"
          Resource  = "*"
          Condition = {
            StringNotEquals = { "aws:PrincipalOrgID" = var.organization_id }
            BoolIfExists    = { "aws:PrincipalIsAWSService" = "false" }
          }
        },
        {
          Sid       = "NobodyElseReadsTheValue"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"]
          Resource  = "*"
          Condition = { ArnNotEquals = { "aws:PrincipalArn" = local.allowed_readers[each.key] } }
        },
        {
          Sid       = "NobodyElseWritesTheValue"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["secretsmanager:PutSecretValue", "secretsmanager:RestoreSecret"]
          Resource  = "*"
          Condition = { ArnNotEquals = { "aws:PrincipalArn" = distinct(concat(each.value.writers, var.break_glass_role_arns)) } }
        },
        {
          # UpdateSecret changes metadata (description, key) and can write a value; the apply
          # roles may call it because gh-tf-* carry an identity-side deny on PutSecretValue and
          # the value reads, and Terraform sets no value (no secret_string anywhere).
          Sid       = "NobodyElseUpdatesTheSecret"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["secretsmanager:UpdateSecret"]
          Resource  = "*"
          Condition = { ArnNotEquals = { "aws:PrincipalArn" = distinct(concat(each.value.writers, var.apply_role_arns, var.break_glass_role_arns)) } }
        },
      ],
      length(each.value.writers) > 0 ? [{
        Sid       = "WritersOnly"
        Effect    = "Allow"
        Principal = { AWS = each.value.writers }
        Action    = ["secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource  = "*"
      }] : [],
    )
  })
}

resource "aws_secretsmanager_secret_rotation" "this" {
  for_each            = var.rotation_lambda_arn == null ? {} : var.secrets
  secret_id           = aws_secretsmanager_secret.this[each.key].id
  rotation_lambda_arn = var.rotation_lambda_arn
  rotate_immediately  = false # no value exists yet on first apply; the first rotation runs on schedule
  rotation_rules {
    automatically_after_days = var.rotation_days
  }

  lifecycle {
    precondition {
      condition     = length(var.secrets[each.key].writers) > 0
      error_message = "A secret with rotation needs the rotation function's role in writers; otherwise the policy denies PutSecretValue and rotation fails silently."
    }
  }
}
