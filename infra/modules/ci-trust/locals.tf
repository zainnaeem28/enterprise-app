# Role catalog, record kinds and the least-privilege policy statements for every
# gh-* role (DEVOPS-PLAN 7.1, 7.2, 7.4, 7.5). Policies are built with jsonencode
# so the tests can assert on the real actions. Nothing here grants IAM write or
# ecs:RegisterTaskDefinition to a gh-* role; those stay with platform-admin-apply.

locals {
  record_kinds = {
    "ci"                = { max_hours = 8760, min_approvals = 1 }
    "staging-release"   = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "staging-infra"     = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "staging-rehearsal" = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "release"           = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "recover"           = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "infra"             = { max_hours = var.release_window_max_hours, min_approvals = 1 }
    "restore-test"      = { max_hours = 8760, min_approvals = 1 }
    "audit-archive"     = { max_hours = 24, min_approvals = 2 }
    "bootstrap"         = { max_hours = 24, min_approvals = 2 }
    "marketing"         = { max_hours = var.release_window_max_hours, min_approvals = 1 }
  }

  # "bootstrap-prod" -> kind "bootstrap"; "marketing-staging" -> "marketing".
  record_kind = { for k, r in var.records : k => (startswith(k, "bootstrap-") ? "bootstrap" : startswith(k, "marketing-") ? "marketing" : k) }

  # Record names this instance can hold: one per kind, per-env for bootstrap and marketing.
  known_records = concat(
    ["ci", "staging-release", "staging-infra", "staging-rehearsal", "release", "recover", "infra", "restore-test", "audit-archive"],
    [for e in var.bootstrap_envs : "bootstrap-${e}"],
    [for e in var.marketing_envs : "marketing-${e}"],
  )

  # Every role: the record that enables it, the GitHub environment and workflow file
  # its token must carry, the refs it accepts and its maximum session (7.2).
  # `main` roles accept only refs/heads/main. Plan roles also accept pull-request merge refs.
  main_ref = ["refs/heads/main"]
  pr_refs  = ["refs/heads/main", "refs/pull/*/merge"]

  catalog_static = {
    "gh-ci-plan"            = { record = "ci", record_env = "tooling", environment = "infra-plan", workflow = "infra.yml", refs = local.pr_refs, session = 3600 }
    "gh-build"              = { record = "ci", record_env = "tooling", environment = "build", workflow = "build-release.yml", refs = local.main_ref, session = 3600 }
    "gh-nightly-staging"    = { record = "ci", record_env = "tooling", environment = "nightly-staging", workflow = "nightly.yml", refs = local.main_ref, session = 7200 }
    "gh-deploy-staging"     = { record = "staging-release", record_env = "staging", environment = "staging", workflow = "deploy-staging.yml", refs = local.main_ref, session = 7200 }
    "gh-tf-staging"         = { record = "staging-infra", record_env = "staging", environment = "staging-infra", workflow = "infra.yml", refs = local.main_ref, session = 7200 }
    "gh-rehearsal-staging"  = { record = "staging-rehearsal", record_env = "staging", environment = "staging-rehearsal", workflow = "rehearsal.yml", refs = local.main_ref, session = 7200 }
    "gh-deploy-production"  = { record = "release", record_env = "production", environment = "production", workflow = "deploy-production.yml", refs = local.main_ref, session = 7200 }
    "gh-observe-production" = { record = "release", record_env = "production", environment = "production", workflow = "deploy-production.yml", refs = local.main_ref, session = 18000 }
    "gh-recover-production" = { record = "recover", record_env = "production", environment = "production", workflow = "deploy-production.yml", refs = local.main_ref, session = 7200 }
    "gh-tf-production"      = { record = "infra", record_env = "production", environment = "production-infra", workflow = "infra.yml", refs = local.main_ref, session = 7200 }
    "gh-restore-test"       = { record = "restore-test", record_env = "production", environment = "restore-test", workflow = "restore-test.yml", refs = local.main_ref, session = 7200 }
    "gh-audit-archive"      = { record = "audit-archive", record_env = "production", environment = "audit-archive", workflow = "audit-archive.yml", refs = local.main_ref, session = 3600 }
  }
  catalog_bootstrap = { for e in var.bootstrap_envs : "gh-bootstrap-${e}" => { record = "bootstrap-${e}", record_env = e, environment = "bootstrap-${e}", workflow = "bootstrap.yml", refs = local.main_ref, session = 3600 } }
  catalog_marketing = { for e in var.marketing_envs : "gh-deploy-marketing-${e}" => { record = "marketing-${e}", record_env = "marketing-${e}", environment = "marketing-${e}", workflow = "deploy-marketing.yml", refs = local.main_ref, session = 7200 } }
  catalog           = merge(local.catalog_static, local.catalog_bootstrap, local.catalog_marketing)

  roles = { for n in var.role_names : n => local.catalog[n] if contains(keys(local.catalog), n) }

  # --- trust ---------------------------------------------------------------
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.oidc_provider_arn
  oidc_host         = "token.actions.githubusercontent.com"

  sub_patterns = { for n, r in local.roles : n => [
    for ref in r.refs : format(var.sub_claim_template, var.repository, r.environment, ref, "${var.repository}/.github/workflows/${r.workflow}@${ref}")
  ] }

  # A role is enabled only when its own record exists in var.records. Otherwise its trust
  # policy has a single unconditional Deny and no Allow: nobody can assume it.
  enabled = { for n, r in local.roles : n => contains(keys(var.records), r.record) }

  trust = { for n, r in local.roles : n => local.enabled[n] ? jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AssumeFromPinnedWorkflowWhileRecordIsValid"
      Effect    = "Allow"
      Principal = { Federated = local.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals          = { "${local.oidc_host}:aud" = "sts.amazonaws.com" }
        StringLike            = { "${local.oidc_host}:sub" = local.sub_patterns[n] }
        DateGreaterThanEquals = { "aws:CurrentTime" = var.records[r.record].not_before }
        DateLessThan          = { "aws:CurrentTime" = var.records[r.record].expires }
      }
    }]
    }) : jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DeniedUntilApprovedReleaseRecordIsApplied"
      Effect    = "Deny"
      Principal = { AWS = "*" }
      Action    = "sts:*"
    }]
  }) }

  # --- helpers for policy statements ------------------------------------------
  # A statement whose resource list is empty is dropped, so an unset input grants nothing.
  records_arn = { for n, r in local.catalog : n => "arn:aws:ssm:${var.region}:${var.account_id}:parameter/approved/${r.record}" }

  granted = { for n, r in local.catalog : n => (contains(keys(var.records), r.record) ? var.records[r.record].permitted_actions : ["*"]) }

  iam_write_prefixes = [for p in ["Create", "Delete", "Update", "Put", "Attach", "Detach", "Add", "Remove", "Set", "Tag", "Untag", "Enable", "Disable", "Upload", "Change", "Reset", "Resync", "Deactivate"] : "iam:${p}*"]

  # Denied to every gh-* role regardless of what the allow side says (defence in
  # depth under the SCP of 7.5 and the permission boundary).
  deny_common = [
    {
      sid       = "NoIamWriteExceptServiceLinkedRoles"
      effect    = "Deny"
      actions   = local.iam_write_prefixes
      resources = null
      not_res   = ["arn:aws:iam::*:role/aws-service-role/*"]
    },
    {
      sid       = "NoTaskDefinitionRegistrationOrShell"
      effect    = "Deny"
      actions   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:ExecuteCommand"]
      resources = ["*"]
      not_res   = null
    },
    {
      sid       = "NoApprovalsRecordWrites"
      effect    = "Deny"
      actions   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion"]
      resources = ["arn:aws:ssm:*:*:parameter/approved/*"]
      not_res   = null
    },
    {
      sid       = "NoApprovalsStateOrKey"
      effect    = "Deny"
      actions   = ["s3:*", "kms:*"]
      resources = [var.approvals_state_bucket_arn, "${var.approvals_state_bucket_arn}/*", var.approvals_kms_key_arn]
      not_res   = null
    },
    {
      sid       = "NoSecretValueReads"
      effect    = "Deny"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:BatchGetSecretValue"]
      resources = ["*"]
      not_res   = null
    },
    {
      sid       = "NoCognitoAdminOperations"
      effect    = "Deny"
      actions   = ["cognito-idp:Admin*"]
      resources = ["*"]
      not_res   = null
    },
  ]
}
