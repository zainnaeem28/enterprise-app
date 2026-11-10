mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_db_instance" {
    defaults = { arn = "arn:aws:rds:us-east-1:111111111111:db:mock" }
  }
}

mock_provider "aws" {
  alias = "recovery"
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-replica" }
  }
}

variables {
  name_prefix               = "t"
  vpc_id                    = "vpc-1"
  data_subnet_ids           = ["subnet-a", "subnet-b"]
  client_security_group_ids = ["sg-api"]
  kms_key_arn               = "arn:aws:kms:us-east-1:111111111111:key/aaaa"
  recovery_kms_key_arn      = "arn:aws:kms:us-west-2:111111111111:key/bbbb"
  backup_copy_vault_arns    = ["arn:aws:backup:us-east-1:222222222222:backup-vault:v"]
}

run "production_defaults" {
  command = plan
  assert {
    condition     = aws_db_instance.this.engine == "postgres" && startswith(aws_db_instance.this.engine_version, "17")
    error_message = "engine must be PostgreSQL 17"
  }
  assert {
    condition     = aws_db_instance.this.multi_az == true && aws_db_instance.this.storage_encrypted == true && aws_db_instance.this.publicly_accessible == false
    error_message = "Multi-AZ, encrypted, private"
  }
  assert {
    condition     = aws_db_instance.this.backup_retention_period == 35 && aws_db_instance.this.deletion_protection == true
    error_message = "35 day PITR and deletion protection"
  }
  assert {
    condition     = aws_db_instance.this.manage_master_user_password == true && aws_db_instance.this.password == null
    error_message = "master password must be RDS-managed, never in configuration"
  }
  assert {
    condition     = aws_db_parameter_group.this.family == "postgres17"
    error_message = "postgres17 parameter group family"
  }
  assert {
    condition     = length([for p in aws_db_parameter_group.this.parameter : p if p.name == "transaction_timeout"]) == 1
    error_message = "parameter group must declare transaction_timeout"
  }
  assert {
    condition     = length(aws_db_instance_automated_backups_replication.recovery) == 1
    error_message = "cross-Region automated backup replication"
  }
  assert {
    condition     = length(aws_backup_plan.database) == 1 && length(aws_backup_plan.database[0].rule) == 2
    error_message = "daily and monthly backup rules"
  }
}

run "role_level_bound_is_declared_for_audit_writers" {
  command = plan
  assert {
    condition     = alltrue([for r in ["app_api", "app_worker", "audit_archiver"] : output.role_level_settings[r].transaction_timeout == "60s"])
    error_message = "app_api, app_worker and audit_archiver must carry transaction_timeout 60s"
  }
}

run "staging_single_az" {
  command = plan
  variables {
    multi_az = false
  }
  assert {
    condition     = aws_db_instance.this.multi_az == false
    error_message = "staging may be single-AZ"
  }
}

run "rejects_default_master_name" {
  command = plan
  variables {
    master_username = "postgres"
  }
  expect_failures = [var.master_username]
}

run "rejects_old_engine" {
  command = plan
  variables {
    engine_version = "16.4"
  }
  expect_failures = [var.engine_version]
}

run "replication_needs_recovery_key" {
  command = plan
  variables {
    recovery_kms_key_arn = null
  }
  expect_failures = [var.recovery_kms_key_arn]
}

run "single_subnet_rejected" {
  command = plan
  variables {
    data_subnet_ids = ["subnet-a"]
  }
  expect_failures = [var.data_subnet_ids]
}

run "backup_retention_below_vault_lock_minimum_rejected" {
  command = plan
  variables {
    backup_retention_days = 14
  }
  expect_failures = [aws_backup_plan.database]
}

run "monthly_retention_above_vault_lock_maximum_rejected" {
  command = plan
  variables {
    monthly_retention_days = 500
  }
  expect_failures = [aws_backup_plan.database]
}

run "backup_role_has_no_restore_policy" {
  command = plan
  assert {
    condition     = aws_iam_role_policy_attachment.backup[0].policy_arn != aws_iam_role_policy_attachment.restore[0].policy_arn && length(aws_iam_role.restore) == 1
    error_message = "restore permissions belong to a separate restore role"
  }
}
