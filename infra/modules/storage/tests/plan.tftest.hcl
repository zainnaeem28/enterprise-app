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
  name_prefix                 = "t"
  kms_key_arn                 = "arn:aws:kms:us-east-1:111111111111:key/aaaa"
  replica_kms_key_arn         = "arn:aws:kms:us-west-2:111111111111:key/bbbb"
  clean_writer_principal_arns = ["arn:aws:iam::111111111111:role/scan-promoter"]
}

run "two_buckets_encrypted_and_blocked" {
  command = plan
  assert {
    condition     = aws_s3_bucket.quarantine.bucket == "t-docs-quarantine" && aws_s3_bucket.clean.bucket == "t-docs-clean"
    error_message = "quarantine and clean buckets"
  }
  assert {
    condition     = alltrue([for v in [aws_s3_bucket_server_side_encryption_configuration.quarantine, aws_s3_bucket_server_side_encryption_configuration.clean] : one(v.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"])
    error_message = "SSE-KMS on both buckets"
  }
  assert {
    condition     = alltrue([for v in [aws_s3_bucket_public_access_block.quarantine, aws_s3_bucket_public_access_block.clean] : v.block_public_acls && v.block_public_policy && v.ignore_public_acls && v.restrict_public_buckets])
    error_message = "public access blocked"
  }
  assert {
    condition     = aws_s3_bucket_versioning.clean.versioning_configuration[0].status == "Enabled"
    error_message = "clean bucket versioned"
  }
}

run "clean_replicated_with_rtc_quarantine_not" {
  command = plan
  assert {
    condition     = length(aws_s3_bucket_replication_configuration.clean) == 1
    error_message = "clean bucket replicates"
  }
  assert {
    condition     = aws_s3_bucket_replication_configuration.clean[0].rule[0].destination[0].replication_time[0].status == "Enabled" && aws_s3_bucket_replication_configuration.clean[0].rule[0].destination[0].replication_time[0].time[0].minutes == 15
    error_message = "Replication Time Control 15 minutes"
  }
}

run "replication_off_needs_no_recovery_key" {
  command = plan
  variables {
    replication_enabled = false
    replica_kms_key_arn = null
  }
  assert {
    condition     = length(aws_s3_bucket_replication_configuration.clean) == 0 && length(aws_s3_bucket.replica) == 0
    error_message = "no replica when disabled"
  }
}

run "replication_requires_replica_key" {
  command = plan
  variables {
    replica_kms_key_arn = null
  }
  expect_failures = [var.replication_enabled]
}

run "bucket_policies_enforce_tls_and_single_clean_writer" {
  command = plan
  assert {
    condition     = anytrue([for s in data.aws_iam_policy_document.clean.statement : s.sid == "DenyInsecureTransport" && s.effect == "Deny"])
    error_message = "TLS-only on clean"
  }
  assert {
    condition     = anytrue([for s in data.aws_iam_policy_document.clean.statement : s.sid == "OnlyPromotionRoleWritesClean" && s.effect == "Deny"])
    error_message = "only the promotion role writes the clean bucket"
  }
  assert {
    condition     = anytrue([for s in data.aws_iam_policy_document.quarantine.statement : s.sid == "DenyInsecureTransport" && s.effect == "Deny"])
    error_message = "TLS-only on quarantine"
  }
}
