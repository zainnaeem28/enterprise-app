# RDS for PostgreSQL 17: Multi-AZ, encrypted, private, point-in-time recovery,
# cross-Region automated backup replication and an AWS Backup plan that copies
# into the vault-locked vaults of the log-archive account.
# DEVOPS-PLAN 3.2, 5.2, 8, 10.1; ARCHITECTURE 9.3, 9.4. Authored only, never applied here.

locals {
  identifier = "${var.name_prefix}-pg"

  # Role-level settings the login roles must carry (ARCHITECTURE section 21,
  # SAR-10). Applied by the F-03 roles bootstrap with ALTER ROLE ... SET; kept
  # here so the expected values are in one reviewable place and can be probed.
  role_level_settings = {
    app_api = {
      transaction_timeout                 = "60s"
      statement_timeout                   = "15s"
      idle_in_transaction_session_timeout = "30s"
      lock_timeout                        = "5s"
    }
    app_worker = {
      transaction_timeout                 = "60s"
      statement_timeout                   = "50s"
      idle_in_transaction_session_timeout = "30s"
      lock_timeout                        = "5s"
    }
    audit_archiver = {
      transaction_timeout = "60s"
    }
  }
}

resource "aws_db_subnet_group" "this" {
  name       = local.identifier
  subnet_ids = var.data_subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "db" {
  name        = "${local.identifier}-db"
  description = "PostgreSQL access from application tasks only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${local.identifier}-db" })
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from application security group"
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.identifier}-"
  family      = "postgres17"
  description = "EHR PostgreSQL 17 parameters"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }
  parameter {
    name  = "password_encryption"
    value = "scram-sha-256"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  # Statement text can contain PHI; log shapes and timings, not parameters.
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
  # Instance default only. The 60 s bound is role-level (role_level_settings).
  # UNVERIFIED on RDS (C-01): proven by verification/transaction_timeout_probe.sql in staging.
  parameter {
    name  = "transaction_timeout"
    value = tostring(var.transaction_timeout_ms)
  }

  lifecycle {
    create_before_destroy = true
  }
  tags = var.tags
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${local.identifier}-enhanced-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

#trivy:ignore:AWS-0176 application roles authenticate with Secrets Manager-held credentials created by the F-03 roles bootstrap; IAM database authentication is a separate auth path that has not been designed or reviewed
resource "aws_db_instance" "this" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  db_name        = var.db_name

  # The master password is generated and rotated by RDS in Secrets Manager.
  # No password is written in configuration or state. The secret is not
  # exported from this module: application roles use their own credentials
  # (F-03), never the master user.
  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.identifier}-final"

  auto_minor_version_upgrade = true
  apply_immediately          = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  tags = merge(var.tags, { Name = local.identifier, DataClass = "phi" })

  depends_on = [aws_iam_role_policy_attachment.monitoring]
}

# ---------- cross-Region automated backup replication ----------

resource "aws_db_instance_automated_backups_replication" "recovery" {
  count                  = var.recovery_backup_replication_enabled ? 1 : 0
  provider               = aws.recovery
  source_db_instance_arn = aws_db_instance.this.arn
  kms_key_id             = var.recovery_kms_key_arn
  retention_period       = var.backup_retention_days
}

# ---------- AWS Backup: local vault and plan that copies into log-archive ----------

locals {
  backup_enabled = length(var.backup_copy_vault_arns) > 0
}

resource "aws_backup_vault" "local" {
  count       = local.backup_enabled ? 1 : 0
  name        = "${local.identifier}-local"
  kms_key_arn = var.kms_key_arn
  tags        = var.tags
}

data "aws_iam_policy_document" "local_vault" {
  count = local.backup_enabled ? 1 : 0
  statement {
    sid    = "DenyDeleteRecoveryPoints"
    effect = "Deny"
    actions = [
      "backup:DeleteRecoveryPoint",
      "backup:UpdateRecoveryPointLifecycle",
      "backup:PutBackupVaultAccessPolicy",
      "backup:DeleteBackupVaultAccessPolicy",
    ]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_backup_vault_policy" "local" {
  count             = local.backup_enabled ? 1 : 0
  backup_vault_name = aws_backup_vault.local[0].name
  policy            = data.aws_iam_policy_document.local_vault[0].json
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  count              = local.backup_enabled ? 1 : 0
  name               = "${local.identifier}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = local.backup_enabled ? toset([
    "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForRestores",
  ]) : toset([])
  role       = aws_iam_role.backup[0].name
  policy_arn = each.value
}

resource "aws_backup_plan" "database" {
  count = local.backup_enabled ? 1 : 0
  name  = "${local.identifier}-copy-to-log-archive"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.local[0].name
    schedule          = "cron(0 3 * * ? *)"
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.backup_retention_days
    }

    dynamic "copy_action" {
      for_each = toset(var.backup_copy_vault_arns)
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.backup_retention_days
        }
      }
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.local[0].name
    schedule          = "cron(0 4 1 * ? *)"
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.monthly_retention_days
    }

    dynamic "copy_action" {
      for_each = toset(var.backup_copy_vault_arns)
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.monthly_retention_days
        }
      }
    }
  }

  tags = var.tags
}

resource "aws_backup_selection" "database" {
  count        = local.backup_enabled ? 1 : 0
  name         = "${local.identifier}-instance"
  plan_id      = aws_backup_plan.database[0].id
  iam_role_arn = aws_iam_role.backup[0].arn
  resources    = [aws_db_instance.this.arn]
}
