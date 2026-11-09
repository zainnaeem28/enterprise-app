mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

run "rotation_is_on_and_alias_prefixed" {
  command = plan
  variables {
    alias       = "test-key"
    description = "test"
  }
  assert {
    condition     = aws_kms_key.this.enable_key_rotation == true
    error_message = "key rotation must be enabled"
  }
  assert {
    condition     = aws_kms_alias.this.name == "alias/test-key"
    error_message = "alias must be prefixed with alias/"
  }
}

run "deletion_window_validated" {
  command = plan
  variables {
    alias                   = "test-key"
    description             = "test"
    deletion_window_in_days = 3
  }
  expect_failures = [var.deletion_window_in_days]
}
