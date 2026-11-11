# AWS adapters wiring for staging (AWS-DO-1, HEAAA-709). Authored only, never applied: R1 deploys nothing (owner ruling
# 2026-11-11). Every value that depends on a real account (domains, certificates, bucket-name suffixes, SES and SMS
# identities, VAPID keys) is a required input here and is supplied by the operator at the first apply; none is
# committed. The compute module is not instantiated in this root yet (it needs image digests from a release), so the
# `service_wiring` output is the exact input for `services.<name>` there.
# Order for the first apply (humans, platform-admin): this root, then the log-archive root (its bucket and key policies
# name the worker role, which must exist).

variable "organization_id" {
  description = "AWS Organizations ID."
  type        = string
}

variable "bucket_name_prefix" {
  description = "Globally unique prefix of the staging buckets, for example ehr-staging-<random>. Buckets are <prefix>-docs-quarantine, -docs-clean, -privacy-packages, -audit-exports."
  type        = string
}

variable "access_log_bucket_name" {
  description = "S3 server access log bucket in the log-archive account. Null disables bucket logging."
  type        = string
  default     = null
}

variable "ecr_repository_arns" {
  description = "ECR repositories of the api and worker images."
  type        = list(string)
}

variable "extra_execution_secret_names" {
  description = "Other secrets the execution role injects (database credentials of the api and worker)."
  type        = list(string)
  default     = []
}

variable "patient_auth_domain" {
  type = string
}

variable "partner_auth_domain" {
  type = string
}

variable "domain_certificate_arn" {
  description = "ACM certificate in us-east-1 covering both auth domains."
  type        = string
}

variable "ses_domain" {
  type = string
}

variable "ses_from_address" {
  type = string
}

variable "security_contact_email" {
  type = string
}

variable "sms_origination_identity_arn" {
  description = "End User Messaging phone number, pool or sender ID. Null leaves SMS unconfigured (the application refuses SMS)."
  type        = string
  default     = null
}

variable "sms_caller_role_arn" {
  description = "Role Cognito assumes for SMS (owned by the approvals root)."
  type        = string
}

variable "sms_external_id" {
  type = string
}

variable "vapid_public_key" {
  type = string
}

variable "vapid_subject" {
  type = string
}

variable "patient_callback_urls" {
  type = list(string)
}

variable "patient_logout_urls" {
  type = list(string)
}

variable "partner_callback_urls" {
  type = list(string)
}

variable "partner_logout_urls" {
  type = list(string)
}

variable "alarm_topic_arns" {
  description = "SNS topics of the observability module."
  type        = list(string)
}

variable "payload_previous_key_arns" {
  description = "Payload keys whose old sealed blobs the worker may still open after a rotation."
  type        = list(string)
  default     = []
}

variable "recovery_region" {
  description = "Region of the staging anchor-archive replica (the archive module always has one)."
  type        = string
  default     = "us-west-2"
}

provider "aws" {
  alias  = "recovery"
  region = var.recovery_region
  assume_role { role_arn = var.apply_role_arn }
  default_tags { tags = local.tags }
}

locals {
  env           = "staging"
  compute_name  = "ehr-staging"
  vapid_secret  = "app/vapid_private_key"
  anchor_prefix = "ehr-${local.env}"
}

module "aws_adapters" {
  source    = "../../modules/aws-adapters"
  providers = { aws = aws, aws.recovery = aws.recovery }

  env                           = local.env
  compute_name                  = local.compute_name
  data_kms_key_arn              = module.kms_data.key_arn
  secrets_kms_key_arn           = module.kms_secrets.key_arn
  payload_key_multi_region      = false
  payload_previous_key_arns     = var.payload_previous_key_arns
  docs_quarantine_bucket_name   = "${var.bucket_name_prefix}-docs-quarantine"
  docs_clean_bucket_name        = "${var.bucket_name_prefix}-docs-clean"
  bucket_name_prefix            = var.bucket_name_prefix
  access_log_bucket             = var.access_log_bucket_name
  anchor_archive_bucket_name    = module.anchor_archive.archive_bucket_name
  anchor_archive_kms_key_arn    = module.kms_anchor_archive.key_arn
  ses_domain                    = var.ses_domain
  ses_from_address              = var.ses_from_address
  security_contact_email        = var.security_contact_email
  sms_origination_identity_arn  = var.sms_origination_identity_arn
  vapid_public_key              = var.vapid_public_key
  vapid_subject                 = var.vapid_subject
  vapid_private_key_secret_name = "${local.env}/${local.vapid_secret}"
  patient_oidc_issuer           = module.identity.patient_issuer
  patient_oidc_client_id        = module.identity.patient_client_id
  patient_auth_domain           = var.patient_auth_domain
  patient_oidc_redirect_uri     = var.patient_callback_urls[0]
  ecr_repository_arns           = var.ecr_repository_arns
  execution_secret_names        = concat(["${local.env}/${local.vapid_secret}"], var.extra_execution_secret_names)
  alarm_topic_arns              = var.alarm_topic_arns
  tags                          = local.tags
}

module "storage" {
  source    = "../../modules/storage"
  providers = { aws = aws, aws.recovery = aws.recovery }

  name_prefix                 = var.bucket_name_prefix
  kms_key_arn                 = module.kms_data.key_arn
  replication_enabled         = false
  replica_kms_key_arn         = null
  clean_writer_principal_arns = [module.aws_adapters.worker_task_role_arn]
  access_log_bucket           = var.access_log_bucket_name
  tags                        = local.tags
}

module "secrets" {
  source    = "../../modules/secrets"
  providers = { aws = aws, aws.recovery = aws.recovery }

  env             = local.env
  kms_key_arn     = module.kms_secrets.key_arn
  organization_id = var.organization_id
  secrets = {
    (local.vapid_secret) = {
      description = "Web Push VAPID private key (value entered by an operator; the worker reads it as EHR_VAPID_PRIVATE_KEY)"
      readers     = [module.aws_adapters.execution_role_arn]
    }
  }
  tags = local.tags
}

module "identity" {
  source = "../../modules/identity"

  name                   = local.env
  patient_auth_domain    = var.patient_auth_domain
  partner_auth_domain    = var.partner_auth_domain
  domain_certificate_arn = var.domain_certificate_arn
  ses_source_arn         = module.aws_adapters.ses_identity_arn
  ses_from_address       = var.ses_from_address
  ses_configuration_set  = module.aws_adapters.ses_configuration_set_name
  sms_caller_role_arn    = var.sms_caller_role_arn
  sms_external_id        = var.sms_external_id
  region                 = var.primary_region
  patient_callback_urls  = var.patient_callback_urls
  patient_logout_urls    = var.patient_logout_urls
  partner_callback_urls  = var.partner_callback_urls
  partner_logout_urls    = var.partner_logout_urls
  tags                   = local.tags
}

# Staging anchor archive: its own bucket, in GOVERNANCE mode with a short retention, so test anchors are not locked
# forever in the production log-archive bucket. COMPLIANCE retention exists only in production (counsel decision open).
module "kms_anchor_archive" {
  source             = "../../modules/kms"
  alias              = "staging-anchor-archive"
  description        = "staging audit anchor archive"
  multi_region       = true
  service_principals = ["s3.amazonaws.com"]
  tags               = local.tags
}

resource "aws_kms_replica_key" "anchor_archive_recovery" {
  provider        = aws.recovery
  description     = "staging audit anchor archive (recovery Region replica)"
  primary_key_arn = module.kms_anchor_archive.key_arn
  tags            = local.tags
}

module "anchor_archive" {
  source    = "../../modules/archive"
  providers = { aws = aws, aws.recovery = aws.recovery }

  name_prefix                    = local.anchor_prefix
  organization_id                = var.organization_id
  kms_key_arn                    = module.kms_anchor_archive.key_arn
  replica_kms_key_arn            = aws_kms_replica_key.anchor_archive_recovery.arn
  retention_days                 = 1
  object_lock_mode               = "GOVERNANCE"
  anchor_writer_principal_arns   = [module.aws_adapters.worker_task_role_arn]
  anchor_reader_principal_arns   = [module.aws_adapters.worker_task_role_arn]
  vault_lock_changeable_for_days = null
  recovery_vault_enabled         = false
  tags                           = local.tags
}

output "service_wiring" {
  description = "Inputs for the compute module: execution_role_arn, and per service task_role_arn, environment, secret_references (merge with the database and telemetry settings)."
  value = {
    execution_role_arn = module.aws_adapters.execution_role_arn
    api = {
      task_role_arn     = module.aws_adapters.api_task_role_arn
      environment       = module.aws_adapters.api_environment
      secret_references = module.aws_adapters.api_secret_references
    }
    worker = {
      task_role_arn     = module.aws_adapters.worker_task_role_arn
      environment       = module.aws_adapters.worker_environment
      secret_references = module.aws_adapters.worker_secret_references
    }
  }
}

output "worker_task_role_arn" {
  description = "Goes to the log-archive root (anchor writer and reader, key use) ."
  value       = module.aws_adapters.worker_task_role_arn
}

output "ses_dkim_tokens" {
  value = module.aws_adapters.ses_dkim_tokens
}
