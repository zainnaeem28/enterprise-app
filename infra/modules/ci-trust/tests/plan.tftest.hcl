mock_provider "aws" {
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111111111111:policy/gh-role-permission-boundary" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock" }
  }
}

variables {
  repository                 = "example-org/enterprise-app"
  account_id                 = "111111111111"
  ssm_kms_key_arn            = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  state_bucket_arn           = "arn:aws:s3:::example-state"
  state_kms_key_arn          = "arn:aws:kms:us-east-2:222222222222:key/22222222-2222-2222-2222-222222222222"
  approvals_state_bucket_arn = "arn:aws:s3:::example-approvals-state"
  approvals_kms_key_arn      = "arn:aws:kms:us-east-2:222222222222:key/33333333-3333-3333-3333-333333333333"
  bootstrap_envs             = ["production"]
  marketing_envs             = ["staging", "production"]
  role_names = [
    "gh-ci-plan", "gh-build", "gh-nightly-staging", "gh-deploy-staging", "gh-tf-staging", "gh-rehearsal-staging",
    "gh-deploy-production", "gh-observe-production", "gh-recover-production", "gh-tf-production", "gh-restore-test",
    "gh-audit-archive", "gh-bootstrap-production", "gh-deploy-marketing-staging", "gh-deploy-marketing-production",
  ]
  refs = {
    ecs_cluster_arn               = "arn:aws:ecs:us-east-2:111111111111:cluster/prod"
    service_arns                  = ["arn:aws:ecs:us-east-2:111111111111:service/prod/api", "arn:aws:ecs:us-east-2:111111111111:service/prod/worker"]
    migration_task_definition_arn = "arn:aws:ecs:us-east-2:111111111111:task-definition/migrate:7"
    migration_passrole_arns       = ["arn:aws:iam::111111111111:role/migrate-task", "arn:aws:iam::111111111111:role/migrate-exec"]
    recover_passrole_arns         = ["arn:aws:iam::111111111111:role/api-task"]
    restore_task_definition_arn   = "arn:aws:ecs:us-east-2:111111111111:task-definition/restore:3"
    signing_key_arn               = "arn:aws:kms:us-east-2:111111111111:key/22222222-2222-2222-2222-222222222222"
    restore_kms_key_arn           = "arn:aws:kms:us-east-2:111111111111:key/33333333-3333-3333-3333-333333333333"
    secrets_kms_key_arn           = "arn:aws:kms:us-east-2:111111111111:key/44444444-4444-4444-4444-444444444444"
    restore_passrole_arns         = ["arn:aws:iam::111111111111:role/restore-task"]
    workload_passrole             = [{ arn = "arn:aws:iam::111111111111:role/api-task", service = "ecs-tasks.amazonaws.com" }]
  }
}

run "every_role_is_denied_without_a_record" {
  command = plan

  assert {
    condition     = alltrue([for n, t in output.trust_policies : strcontains(t, "\"Effect\":\"Deny\"") && !strcontains(t, "\"Effect\":\"Allow\"")])
    error_message = "with no records every gh-* trust policy must be a single Deny and contain no Allow"
  }
  assert {
    condition     = alltrue([for n, s in output.role_state : s.enabled == false])
    error_message = "no role may be enabled without a record"
  }
  assert {
    condition     = length(output.role_arns) == 0 || length(keys(output.role_state)) == 15
    error_message = "all 15 catalog roles under test must exist"
  }
}

run "no_role_policy_allows_iam_write_task_registration_or_secret_values" {
  command = plan

  assert {
    condition = alltrue([for n, p in output.role_policies : alltrue([for st in jsondecode(p).Statement :
      st.Effect == "Deny" || !anytrue([for a in st.Action : a != "iam:CreateServiceLinkedRole" && anytrue([
        for bad in ["iam:Create", "iam:Delete", "iam:Update", "iam:Put", "iam:Attach", "iam:Detach", "ecs:RegisterTaskDefinition", "ecs:ExecuteCommand", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"] :
        startswith(a, bad)
      ])])
    ])])
    error_message = "an Allow statement grants IAM write, task-definition registration, ECS Exec or secret values"
  }
  assert {
    condition = alltrue([for n, p in output.role_policies : alltrue([for st in jsondecode(p).Statement :
      st.Effect == "Deny" || !contains(st.Action, "*") && !contains(st.Action, "iam:*")
    ])])
    error_message = "no role may have an Allow of * or iam:*"
  }
  assert {
    condition     = !strcontains(output.role_policies["gh-recover-production"], "ecs:RunTask\"") || strcontains(output.role_policies["gh-recover-production"], "\"Deny\"")
    error_message = "gh-recover-production must not be able to run a task"
  }
  assert {
    condition     = !strcontains(jsonencode([for st in jsondecode(output.role_policies["gh-recover-production"]).Statement : st.Action if st.Effect == "Allow"]), "ecs:RunTask")
    error_message = "gh-recover-production has no RunTask in any Allow statement (rollback never migrates, 8.1)"
  }
  assert {
    condition     = alltrue([for n, p in output.role_policies : strcontains(p, "NoApprovalsRecordWrites") && strcontains(p, "NoApprovalsStateOrKey") && strcontains(p, "NoIamWriteExceptServiceLinkedRoles")])
    error_message = "every role carries the explicit control-plane denials"
  }
  assert {
    condition     = alltrue([for n, p in output.role_policies : length(p) <= 10240])
    error_message = "inline policy size limit"
  }
}

run "release_record_enables_only_its_roles_with_pinned_trust" {
  command = plan

  variables {
    records = {
      release = {
        environment       = "production"
        manifest_hash     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        previous_manifest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        permitted_actions = ["migrate", "rollout", "smoke"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-02T00:00:00Z"
        approvals         = ["approver-a"]
        applier           = "platform-admin-b"
      }
    }
  }

  assert {
    condition     = output.role_state["gh-deploy-production"].enabled && output.role_state["gh-observe-production"].enabled
    error_message = "the release record enables the deploy and observe roles"
  }
  assert {
    condition     = !output.role_state["gh-recover-production"].enabled && !output.role_state["gh-restore-test"].enabled && !output.role_state["gh-tf-production"].enabled && !output.role_state["gh-audit-archive"].enabled
    error_message = "a release record must not enable recover, restore-test, infra or audit-archive (one approval, one purpose, 7.4)"
  }
  assert {
    condition = alltrue([
      strcontains(output.trust_policies["gh-deploy-production"], "repo:example-org/enterprise-app:environment:production:ref:refs/heads/main:job_workflow_ref:example-org/enterprise-app/.github/workflows/deploy-production.yml@refs/heads/main"),
      strcontains(output.trust_policies["gh-deploy-production"], "\"aws:CurrentTime\":\"2030-01-02T00:00:00Z\""),
      strcontains(output.trust_policies["gh-deploy-production"], "sts.amazonaws.com"),
    ])
    error_message = "trust must carry repository, environment, ref, workflow ref, audience and the record expiry"
  }
  assert {
    condition     = strcontains(output.role_policies["gh-deploy-production"], "ecs:RunTask") && strcontains(output.role_policies["gh-deploy-production"], "ecs:UpdateService")
    error_message = "migrate and rollout are listed, so both are granted"
  }
}

run "listed_actions_limit_the_deploy_policy" {
  command = plan

  variables {
    records = {
      release = {
        environment       = "production"
        manifest_hash     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        previous_manifest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        permitted_actions = ["rollout", "smoke"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-02T00:00:00Z"
        approvals         = ["approver-a"]
        applier           = "platform-admin-b"
      }
    }
  }

  assert {
    condition     = !strcontains(jsonencode([for st in jsondecode(output.role_policies["gh-deploy-production"]).Statement : st.Action if st.Effect == "Allow"]), "ecs:RunTask")
    error_message = "without 'migrate' in permitted_actions the deploy role must not be able to run the migration task"
  }
}

run "audit_archive_needs_two_distinct_approvals" {
  command = plan

  variables {
    records = {
      audit-archive = {
        environment       = "production"
        permitted_actions = ["archive"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-01T06:00:00Z"
        approvals         = ["approver-a"]
        applier           = "platform-admin-b"
      }
    }
  }
  expect_failures = [terraform_data.checks]
}

run "audit_archive_window_over_one_day_is_rejected" {
  command = plan

  variables {
    records = {
      audit-archive = {
        environment       = "production"
        permitted_actions = ["archive"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-03T00:00:00Z"
        approvals         = ["approver-a", "approver-b"]
        applier           = "platform-admin-c"
      }
    }
  }
  expect_failures = [terraform_data.checks]
}

run "applier_cannot_be_the_sole_approver" {
  command = plan

  variables {
    records = {
      infra = {
        environment       = "production"
        permitted_actions = ["infra-apply"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-02T00:00:00Z"
        approvals         = ["same-person"]
        applier           = "same-person"
      }
    }
  }
  expect_failures = [terraform_data.checks]
}

run "release_without_previous_manifest_needs_first_release_flag" {
  command = plan

  variables {
    records = {
      release = {
        environment       = "production"
        manifest_hash     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        permitted_actions = ["migrate", "rollout"]
        g3_reference      = "G3-example"
        not_before        = "2030-01-01T00:00:00Z"
        expires           = "2030-01-02T00:00:00Z"
        approvals         = ["approver-a"]
        applier           = "platform-admin-b"
      }
    }
  }
  expect_failures = [terraform_data.checks]
}

run "unknown_role_is_rejected" {
  command = plan

  variables {
    role_names = ["gh-god-mode"]
  }
  expect_failures = [terraform_data.checks]
}

run "tf_roles_read_their_record_through_ssm_and_cannot_edit_protecting_controls" {
  command = plan

  assert {
    condition = alltrue([for n in ["gh-tf-staging", "gh-tf-production"] : (
      length([for st in jsondecode(output.role_policies[n]).Statement : st if st.Sid == "NoKeyUseForData" && contains(st.Condition.StringNotEquals["kms:ViaService"], "ssm.us-east-2.amazonaws.com")]) == 1 &&
      length([for st in jsondecode(output.role_policies[n]).Statement : st if st.Sid == "RecordKeyOnlyViaSsm" && st.Resource == [var.ssm_kms_key_arn] && st.Condition.StringNotEquals["kms:ViaService"] == ["ssm.us-east-2.amazonaws.com"]]) == 1 &&
      length([for st in jsondecode(output.role_policies[n]).Statement : st if st.Sid == "StateKeyOnlyViaS3" && st.Condition.StringNotEquals["kms:ViaService"] == ["s3.us-east-2.amazonaws.com"]]) == 1
    )])
    error_message = "the record key is usable through SSM only and the state key through S3 only, so the tf role can read /approved/<record>"
  }
  assert {
    condition = alltrue([for n in ["gh-tf-staging", "gh-tf-production"] : (
      anytrue([for st in jsondecode(output.role_policies[n]).Statement : st.Sid == "NoEditOfRecordAndEvidenceKeys" && contains(st.Resource, var.ssm_kms_key_arn) && contains(st.Resource, var.state_kms_key_arn) && contains(st.Action, "kms:PutKeyPolicy") && contains(st.Action, "kms:ScheduleKeyDeletion")]) &&
      anytrue([for st in jsondecode(output.role_policies[n]).Statement : st.Sid == "NoEditOfEvidenceBuckets" && contains(st.Resource, var.state_bucket_arn) && contains(st.Action, "s3:PutBucket*")])
    )])
    error_message = "tf roles must be denied edits of the record key, the state key and the state bucket policy"
  }
}

run "infra_roles_cannot_edit_signing_restore_secrets_keys_or_secret_policies" {
  command = plan

  assert {
    condition = alltrue([for n in ["gh-tf-staging", "gh-tf-production", "gh-rehearsal-staging"] : (
      anytrue([for st in jsondecode(output.role_policies[n]).Statement : st.Sid == "NoEditOfRecordAndEvidenceKeys" && st.Effect == "Deny" &&
        alltrue([for k in [var.refs.signing_key_arn, var.refs.restore_kms_key_arn, var.refs.secrets_kms_key_arn] : contains(st.Resource, k)]) &&
        alltrue([for a in ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:Revoke*", "kms:Disable*", "kms:ScheduleKeyDeletion"] : contains(st.Action, a)])]) &&
      anytrue([for st in jsondecode(output.role_policies[n]).Statement : st.Sid == "NoEditOfSecretResourcePolicies" && st.Effect == "Deny" && contains(st.Action, "secretsmanager:PutResourcePolicy") && contains(st.Action, "secretsmanager:DeleteResourcePolicy")]) &&
      !anytrue([for st in jsondecode(output.role_policies[n]).Statement : st.Effect == "Allow" && (contains(try(tolist(st.Action), [st.Action]), "secretsmanager:PutResourcePolicy") || contains(try(tolist(st.Action), [st.Action]), "secretsmanager:DeleteResourcePolicy"))])
    )])
    error_message = "infra roles must be denied key-policy edits on signing, restore and secrets keys and may not put or delete secret resource policies"
  }
}
