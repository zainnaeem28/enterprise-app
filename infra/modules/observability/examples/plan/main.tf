# Offline plan root for the observability module. Fake credentials and every account/metadata call skipped: the plan
# reads no AWS state and an apply from here is impossible by design (no backend, no real account). Used only to
# produce a plan artifact for review and for the PHI canary scan.

terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region                      = "us-east-2"
  access_key                  = "offline-plan-only"
  secret_key                  = "offline-plan-only"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

module "observability" {
  source = "../.."

  name                      = "ehr-production"
  region                    = "us-east-2"
  account_id                = "111111111111"
  kms_key_arn               = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  alb_arn_suffix            = "app/ehr-production-alb/1111111111111111"
  target_group_arn_suffixes = { api = "targetgroup/ehr-production-api/3333333333333333" }
  ecs_cluster_name          = "ehr-production"
  db_instance_identifier    = "ehr-production-db"
  log_group_names           = ["/ehr-production/api", "/ehr-production/worker"]
  certificate_arns          = { portals = "arn:aws:acm:us-east-2:111111111111:certificate/11111111-1111-1111-1111-111111111111" }
  waf_web_acls              = { ehr-production-alb = { scope = "REGIONAL" } }
  backup_vault_name         = "ehr-production-vault"
  recovery_region           = "us-west-2"
  backup_replication_rules  = { audit = { source_bucket = "audit-archive", destination_bucket = "audit-archive-recovery", rule_id = "all" } }
  integration_vendors       = { sms = { criticality = "page" }, video = { criticality = "ticket" } }
  break_glass_role_arns     = ["arn:aws:iam::111111111111:role/bg-admin"]
  migration_task_family     = "ehr-production-migrate"
  page_email_endpoints      = ["oncall-placeholder@example.invalid"]
  security_email_endpoints  = ["security-placeholder@example.invalid"]
  ticket_email_endpoints    = ["tickets-placeholder@example.invalid"]
  adot_image                = "111111111111.dkr.ecr.us-east-2.amazonaws.com/adot@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  canary_artifacts_bucket   = "ehr-production-canary-artifacts"
  canaries = {
    my-shallow    = { url = "https://my.example.test/healthz", kind = "shallow", every_minutes = 1, page_on_failure = true, release_json_url = "https://my.example.test/release.json" }
    staff-shallow = { url = "https://staff.example.test/healthz", kind = "shallow", every_minutes = 1, page_on_failure = true, release_json_url = "https://staff.example.test/release.json" }
    my-journey    = { url = "https://my.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    staff-journey = { url = "https://staff.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    integrations  = { url = "https://integrations.example.test/public/v1", kind = "journey", every_minutes = 5, page_on_failure = false }
    pharmacy      = { url = "https://pharmacy.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    www           = { url = "https://www.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
    cms           = { url = "https://cms.example.test/", kind = "journey", every_minutes = 5, page_on_failure = false }
  }
}
