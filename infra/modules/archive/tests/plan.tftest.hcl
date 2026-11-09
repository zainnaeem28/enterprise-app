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
  name_prefix           = "t"
  organization_id       = "o-abc123def4"
  kms_key_arn           = "arn:aws:kms:us-east-1:333333333333:key/aaaa"
  replica_kms_key_arn   = "arn:aws:kms:us-west-2:333333333333:key/bbbb"
  retention_days        = 2190
  writer_principal_arns = ["arn:aws:iam::111111111111:role/audit-archiver"]
}

run "object_lock_compliance_on_archive_and_replica" {
  command = plan
  assert {
    condition     = aws_s3_bucket.archive.object_lock_enabled == true && aws_s3_bucket.replica.object_lock_enabled == true
    error_message = "Object Lock on archive and replica"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.archive.rule).default_retention[0].mode == "COMPLIANCE" && one(aws_s3_bucket_object_lock_configuration.replica.rule).default_retention[0].mode == "COMPLIANCE"
    error_message = "compliance mode on both"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.archive.rule).default_retention[0].days == 2190
    error_message = "retention comes from the variable"
  }
  assert {
    condition     = length(aws_s3_bucket_replication_configuration.archive.rule) == 1
    error_message = "archive replicates to the recovery Region"
  }
}

run "backup_vaults_locked" {
  command = plan
  assert {
    condition     = aws_backup_vault_lock_configuration.primary.changeable_for_days == 7 && aws_backup_vault_lock_configuration.primary.min_retention_days == 35
    error_message = "vault lock with cooling-off period"
  }
  assert {
    condition     = length(aws_backup_vault.recovery) == 1 && length(aws_backup_vault_lock_configuration.recovery) == 1
    error_message = "recovery-Region vault is locked too"
  }
}

run "retention_has_no_default" {
  command = plan
  variables {
    retention_days = 0
  }
  expect_failures = [var.retention_days]
}

run "bad_lock_mode_rejected" {
  command = plan
  variables {
    object_lock_mode = "NONE"
  }
  expect_failures = [var.object_lock_mode]
}

run "nobody_can_delete_or_shorten_retention" {
  command = plan
  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.archive.statement :
      s.sid == "DenyDeleteAndRetentionChanges" && s.effect == "Deny" &&
      contains(s.actions, "s3:DeleteObject") && contains(s.actions, "s3:DeleteObjectVersion") &&
      contains(s.actions, "s3:BypassGovernanceRetention") && contains(s.actions, "s3:PutBucketObjectLockConfiguration") &&
      length(s.condition) == 0
    ])
    error_message = "archive bucket policy must deny delete and retention changes to everyone, with no exception"
  }
  assert {
    condition = !anytrue([for s in data.aws_iam_policy_document.archive.statement :
      s.effect == "Allow" && anytrue([for a in s.actions : can(regex("Delete|Retention|ObjectLockConfiguration", a))])
    ])
    error_message = "no Allow statement may grant delete or retention actions"
  }
  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.vault_primary.statement :
      s.sid == "DenyDeleteRecoveryPoints" && s.effect == "Deny" && contains(s.actions, "backup:DeleteRecoveryPoint")
    ])
    error_message = "backup vault policy denies recovery point deletion"
  }
}
