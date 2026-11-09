mock_provider "aws" {
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-2:111111111111:secret:mock-AbCdEf", id = "arn:aws:secretsmanager:us-east-2:111111111111:secret:mock-AbCdEf" }
  }
}

variables {
  env             = "staging"
  kms_key_arn     = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  organization_id = "o-exampleorg"
  secrets = {
    "db/app_owner" = {
      description = "Migration credential"
      readers     = ["arn:aws:iam::111111111111:role/migrate-task"]
      writers     = ["arn:aws:iam::111111111111:role/rotation"]
    }
    "db/app_api" = {
      description = "API credential"
      readers     = ["arn:aws:iam::111111111111:role/api-task"]
    }
  }
}

run "containers_only_with_pinned_readers" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret.this) == 2 && aws_secretsmanager_secret.this["db/app_owner"].name == "staging/db/app_owner"
    error_message = "names carry the environment prefix"
  }
  assert {
    condition     = aws_secretsmanager_secret.this["db/app_owner"].kms_key_id == "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
    error_message = "secrets use the customer-managed key"
  }
  assert {
    condition     = strcontains(aws_secretsmanager_secret_policy.this["db/app_api"].policy, "NobodyElseReadsTheValue") && strcontains(aws_secretsmanager_secret_policy.this["db/app_api"].policy, "OrganisationOnly") && strcontains(aws_secretsmanager_secret_policy.this["db/app_api"].policy, "TlsOnly")
    error_message = "resource policy denies other readers, outside-organisation principals and non-TLS"
  }
  assert {
    condition     = !strcontains(aws_secretsmanager_secret_policy.this["db/app_api"].policy, "WritersOnly")
    error_message = "a secret with no writer has no write allowance"
  }
  assert {
    condition     = length(aws_secretsmanager_secret_rotation.this) == 0
    error_message = "no rotation without a rotation function"
  }
}

run "rotation_scheduled_when_function_given" {
  command = plan

  variables {
    rotation_lambda_arn = "arn:aws:lambda:us-east-2:111111111111:function:rotate"
  }
  assert {
    condition     = length(aws_secretsmanager_secret_rotation.this) == 2
    error_message = "rotation is scheduled for every container"
  }
}

run "runtime_secrets_are_not_containers" {
  command = plan

  variables {
    secrets = {
      "integration/outbound/video" = {
        description = "x"
        readers     = ["arn:aws:iam::111111111111:role/api-task"]
      }
    }
  }
  expect_failures = [var.secrets]
}

run "replica_requires_key" {
  command = plan

  variables {
    recovery_region = "us-west-2"
  }
  expect_failures = [aws_secretsmanager_secret.this]
}
