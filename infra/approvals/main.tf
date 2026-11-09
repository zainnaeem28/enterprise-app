# Approvals root: the OIDC providers, gh-* roles, their permission boundaries and the
# /approved/* records. Human-applied only (platform-admin-apply). STRUCTURE ONLY in
# DO-04: nothing is applied, every record is empty, so every role is denied.
#
# Not here: the staging instance (infra/approvals-staging, own state in the staging
# account, DEVOPS-PLAN 7.5) and the SCPs (management root). The ci-trust catalog already
# contains the staging roles (gh-deploy-staging, gh-tf-staging, gh-rehearsal-staging,
# gh-nightly-staging) so that root can instantiate the same module.

provider "aws" {
  alias  = "production"
  region = var.primary_region
  assume_role { role_arn = var.production_apply_role_arn }
  default_tags { tags = local.tags }
}

provider "aws" {
  alias  = "tooling"
  region = var.primary_region
  assume_role { role_arn = var.tooling_apply_role_arn }
  default_tags { tags = local.tags }
}

provider "aws" {
  alias  = "marketing"
  region = var.primary_region
  assume_role { role_arn = var.marketing_apply_role_arn }
  default_tags { tags = local.tags }
}

locals {
  tags = { Project = "ehr-platform", ManagedBy = "opentofu", Root = "approvals" }
}

module "ci_trust_production" {
  source    = "../modules/ci-trust"
  providers = { aws = aws.production }

  repository                 = var.github_repository
  account_id                 = var.production_account_id
  region                     = var.primary_region
  bootstrap_envs             = ["production"]
  role_names                 = ["gh-ci-plan", "gh-deploy-production", "gh-observe-production", "gh-recover-production", "gh-tf-production", "gh-restore-test", "gh-audit-archive", "gh-bootstrap-production"]
  records                    = var.production_records
  refs                       = var.production_refs
  ssm_kms_key_arn            = var.production_ssm_kms_key_arn
  state_bucket_arn           = var.workload_state_bucket_arn
  state_kms_key_arn          = var.workload_state_kms_key_arn
  approvals_state_bucket_arn = var.approvals_state_bucket_arn
  approvals_kms_key_arn      = var.approvals_kms_key_arn
  tags                       = local.tags
}

module "ci_trust_tooling" {
  source    = "../modules/ci-trust"
  providers = { aws = aws.tooling }

  repository                 = var.github_repository
  account_id                 = var.tooling_account_id
  region                     = var.primary_region
  role_names                 = ["gh-ci-plan", "gh-build"]
  records                    = var.tooling_records
  refs                       = var.tooling_refs
  ssm_kms_key_arn            = var.tooling_ssm_kms_key_arn
  state_bucket_arn           = var.workload_state_bucket_arn
  state_kms_key_arn          = var.workload_state_kms_key_arn
  approvals_state_bucket_arn = var.approvals_state_bucket_arn
  approvals_kms_key_arn      = var.approvals_kms_key_arn
  tags                       = local.tags
}

module "ci_trust_marketing" {
  source    = "../modules/ci-trust"
  providers = { aws = aws.marketing }

  repository                 = var.github_repository
  account_id                 = var.marketing_account_id
  region                     = var.primary_region
  marketing_envs             = ["staging", "production"]
  role_names                 = ["gh-ci-plan", "gh-deploy-marketing-staging", "gh-deploy-marketing-production"]
  records                    = var.marketing_records
  refs                       = var.marketing_refs
  ssm_kms_key_arn            = var.marketing_ssm_kms_key_arn
  state_bucket_arn           = var.workload_state_bucket_arn
  state_kms_key_arn          = var.workload_state_kms_key_arn
  approvals_state_bucket_arn = var.approvals_state_bucket_arn
  approvals_kms_key_arn      = var.approvals_kms_key_arn
  tags                       = local.tags
}
