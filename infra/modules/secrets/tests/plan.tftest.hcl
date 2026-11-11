mock_provider "aws" {
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-2:111111111111:secret:mock-AbCdEf", id = "arn:aws:secretsmanager:us-east-2:111111111111:secret:mock-AbCdEf" }
  }
}

mock_provider "aws" {
  alias = "recovery"
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
    secrets = {
      "db/app_owner" = { description = "a", readers = ["arn:aws:iam::111111111111:role/migrate-task"], writers = ["arn:aws:iam::111111111111:role/rotation"] }
      "db/app_api"   = { description = "b", readers = ["arn:aws:iam::111111111111:role/api-task"], writers = ["arn:aws:iam::111111111111:role/rotation"] }
    }
  }
  assert {
    condition     = length(aws_secretsmanager_secret_rotation.this) == 2 && aws_secretsmanager_secret_rotation.this["db/app_api"].rotate_immediately == false
    error_message = "rotation is scheduled for every container and does not rotate on first apply"
  }
}

run "rotation_without_a_writer_is_rejected" {
  command = plan

  variables {
    rotation_lambda_arn = "arn:aws:lambda:us-east-2:111111111111:function:rotate"
  }
  expect_failures = [aws_secretsmanager_secret_rotation.this]
}

run "apply_role_may_update_metadata_but_not_put_values" {
  command = plan

  variables {
    apply_role_arns = ["arn:aws:iam::111111111111:role/gh-tf-staging"]
  }
  assert {
    condition = alltrue([for k, p in aws_secretsmanager_secret_policy.this : anytrue([for st in jsondecode(p.policy).Statement :
      st.Sid == "NobodyElseUpdatesTheSecret" && contains(st.Condition.ArnNotEquals["aws:PrincipalArn"], "arn:aws:iam::111111111111:role/gh-tf-staging")
      ]) && !anytrue([for st in jsondecode(p.policy).Statement :
      st.Sid == "NobodyElseWritesTheValue" && contains(st.Condition.ArnNotEquals["aws:PrincipalArn"], "arn:aws:iam::111111111111:role/gh-tf-staging")
    ])])
    error_message = "apply role is excepted from the metadata-update deny only, never from the value-write deny"
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

run "replica_in_the_recovery_region_with_its_own_key" {
  command = plan

  variables {
    recovery_region     = "us-west-2"
    replica_kms_key_arn = "arn:aws:kms:us-west-2:111111111111:key/22222222-2222-2222-2222-222222222222"
  }
  assert {
    condition = alltrue([for k, s in aws_secretsmanager_secret.this :
      length(s.replica) == 1 && one(s.replica).region == "us-west-2" && one(s.replica).kms_key_id == "arn:aws:kms:us-west-2:111111111111:key/22222222-2222-2222-2222-222222222222"
    ])
    error_message = "every secret has exactly one replica, in the recovery Region, under the recovery-Region key"
  }

  # AWS replicates the resource policy to a replica; the same policy is also attached explicitly in the recovery Region (guards against drift).
  assert {
    condition = alltrue([for k, p in aws_secretsmanager_secret_policy.replica :
      strcontains(p.secret_arn, ":secretsmanager:us-west-2:") && !strcontains(p.secret_arn, "us-east-2")
    ]) && length(aws_secretsmanager_secret_policy.replica) == length(var.secrets)
    error_message = "every replica has a resource policy, addressed in the recovery Region"
  }
}

run "no_replica_policy_without_a_recovery_region" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret_policy.replica) == 0
    error_message = "no replica policy without recovery_region"
  }
}
