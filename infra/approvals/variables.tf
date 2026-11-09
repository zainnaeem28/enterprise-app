variable "primary_region" {
  type    = string
  default = "us-east-2"
}

variable "github_repository" {
  description = "owner/name of the GitHub repository the roles trust."
  type        = string
}

# Applied only as the platform-admin-apply Identity Center role, never as a gh-* role.
variable "production_apply_role_arn" {
  type = string
}

variable "tooling_apply_role_arn" {
  type = string
}

variable "marketing_apply_role_arn" {
  type = string
}

variable "production_account_id" {
  type = string
}

variable "tooling_account_id" {
  type = string
}

variable "marketing_account_id" {
  type = string
}

variable "workload_state_bucket_arn" {
  description = "Workload state bucket (infra/bootstrap)."
  type        = string
}

variable "workload_state_kms_key_arn" {
  type = string
}

variable "approvals_state_bucket_arn" {
  description = "This root's own state bucket. Every gh-* role is denied on it."
  type        = string
}

variable "approvals_kms_key_arn" {
  type = string
}

variable "production_ssm_kms_key_arn" {
  description = "Key for the /approved/* parameters in production; its key policy limits writes to platform-admin-apply."
  type        = string
}

variable "tooling_ssm_kms_key_arn" {
  type = string
}

variable "marketing_ssm_kms_key_arn" {
  type = string
}

# Approved-release records. The default is empty: every role is denied. A record is
# added only by a pull request that a human who is not the author approves (CODEOWNERS)
# and that a human platform admin applies (DEVOPS-PLAN 4.1 A2). The schema is checked
# by modules/ci-trust.
variable "production_records" {
  type    = any
  default = {}
}

variable "tooling_records" {
  type    = any
  default = {}
}

variable "marketing_records" {
  type    = any
  default = {}
}

# Resource ARNs the role policies point at. Filled in when the ECS, RDS and bucket
# roots exist; an empty value grants nothing.
variable "production_refs" {
  type    = any
  default = {}
}

variable "marketing_refs" {
  type    = any
  default = {}
}

variable "tooling_refs" {
  type    = any
  default = {}
}
