mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b", "us-west-2c"] }
  }
  mock_data "aws_region" {
    defaults = { name = "us-west-2" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "333333333333" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:333333333333:key/11111111-1111-1111-1111-111111111111" }
  }
}

variables {
  expected_account_id      = "333333333333"
  vpc_cidr                 = "10.80.0.0/16"
  flow_log_destination_arn = "arn:aws:s3:::flow-bucket"
  snapshot_arn             = "arn:aws:rds:us-west-2:333333333333:snapshot:loadtest-synthetic-20261101"
  expires_at               = "2026-11-10T00:00:00Z"
  rehearsal_id             = "r1-20261109"
}

run "the_stack_is_synthetic_short_lived_and_leaves_nothing_behind" {
  command = apply

  assert {
    condition     = aws_db_instance.restored.skip_final_snapshot == true && aws_db_instance.restored.deletion_protection == false && aws_db_instance.restored.backup_retention_period == 0
    error_message = "no final snapshot, no deletion protection, no backups: destroy leaves nothing"
  }
  assert {
    condition     = aws_db_instance.restored.publicly_accessible == false && aws_db_instance.restored.storage_encrypted == true
    error_message = "private and encrypted"
  }
  assert {
    condition     = aws_db_instance.restored.snapshot_identifier == "arn:aws:rds:us-west-2:333333333333:snapshot:loadtest-synthetic-20261101"
    error_message = "restores from the synthetic copy"
  }
  assert {
    condition     = aws_db_instance.restored.tags["Synthetic"] == "true" && aws_db_instance.restored.tags["ExpiresAt"] == "2026-11-10T00:00:00Z" && aws_db_instance.restored.tags["Purpose"] == "dr-rehearsal"
    error_message = "tagged synthetic, with its expiry, for the sweep"
  }
}

run "refused_outside_the_staging_account" {
  command = plan
  variables {
    expected_account_id = "444444444444"
    snapshot_arn        = "arn:aws:rds:us-west-2:444444444444:snapshot:loadtest-synthetic-20261101"
  }
  expect_failures = [terraform_data.guard]
}

run "refused_outside_the_recovery_region" {
  command = plan
  variables {
    expected_region = "eu-west-1"
    snapshot_arn    = "arn:aws:rds:eu-west-1:333333333333:snapshot:loadtest-synthetic-20261101"
  }
  expect_failures = [terraform_data.guard]
}

run "refused_for_a_snapshot_that_is_not_marked_synthetic" {
  command = plan
  variables {
    snapshot_arn = "arn:aws:rds:us-west-2:333333333333:snapshot:ehr-production-daily-20261101"
  }
  expect_failures = [terraform_data.guard]
}

run "refused_for_a_name_that_could_be_mistaken_for_an_environment" {
  command = plan
  variables {
    name = "staging"
  }
  expect_failures = [terraform_data.guard]
}

run "refused_for_a_malformed_expiry" {
  command = plan
  variables {
    expires_at = "tomorrow"
  }
  expect_failures = [var.expires_at]
}
