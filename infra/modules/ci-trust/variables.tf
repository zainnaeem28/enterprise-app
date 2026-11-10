variable "repository" {
  description = "GitHub repository allowed to assume the roles, as owner/name."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "repository must be owner/name."
  }
}

variable "role_names" {
  description = "Catalog roles this instance creates (one instance per AWS account; the root selects the roles that belong in that account). Unknown names are rejected."
  type        = set(string)
}

variable "bootstrap_envs" {
  description = "Environments for gh-bootstrap-<env> (DEVOPS-PLAN 7.2)."
  type        = list(string)
  default     = []
}

variable "marketing_envs" {
  description = "Environments for gh-deploy-marketing-<env>, for example staging and production."
  type        = list(string)
  default     = []
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider in this account. At most one instance per account sets this."
  type        = bool
  default     = true
}

variable "oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN when create_oidc_provider is false."
  type        = string
  default     = null
}

variable "sub_claim_template" {
  description = "How the customised OIDC sub claim is rendered. The repository-level customisation must use include_claim_keys = [repo, environment, ref, job_workflow_ref] in this order (DEVOPS-PLAN 7.1). UNVERIFIED until the staging proof; whether AWS also evaluates job_workflow_ref directly is not assumed."
  type        = string
  default     = "repo:%s:environment:%s:ref:%s:job_workflow_ref:%s"
}

variable "records" {
  description = <<-E
    Approved-release records (DEVOPS-PLAN 7.4), keyed by record name. Default {} = every role is denied.
    A record enables exactly the roles that name it, for its own window. Written to SSM by the human-applied approvals root only.
    approvals lists the distinct human approvers; dual-control records need at least two.
  E
  type = map(object({
    environment       = string
    manifest_hash     = optional(string, "")
    previous_manifest = optional(string, "")
    permitted_actions = list(string)
    g3_reference      = string
    not_before        = string
    expires           = string
    approvals         = list(string)
    applier           = string
    first_release     = optional(bool, false)
  }))
  default = {}
}

variable "account_id" {
  description = "AWS account ID of this instance (used to build parameter and role ARNs)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be 12 digits."
  }
}

variable "region" {
  description = "Primary Region of this account."
  type        = string
  default     = "us-east-2"
}

variable "release_window_max_hours" {
  description = "Upper bound for release, recover, infra and staging record windows: observation window plus margin. The G3 package states the final value; 72 is a placeholder, not approved."
  type        = number
  default     = 72
}

variable "ssm_kms_key_arn" {
  description = "KMS key that encrypts the /approved/* SecureString parameters. Its key policy limits writes to platform-admin-apply (set by the approvals root)."
  type        = string
}

variable "state_bucket_arn" {
  description = "Terraform state bucket (tooling account) that gh-ci-plan reads and gh-tf-* roles use for workload-root state. The approvals state bucket is never passed here."
  type        = string
}

variable "state_kms_key_arn" {
  description = "KMS key of the workload state bucket."
  type        = string
}

variable "approvals_state_bucket_arn" {
  description = "Approvals-root state bucket: every role gets an explicit deny on it."
  type        = string
}

variable "approvals_kms_key_arn" {
  description = "Approvals-root KMS key: every role gets an explicit deny on key administration and use."
  type        = string
}

variable "refs" {
  description = "ARNs of resources the role policies point at, for the account this instance runs in. An empty list or null removes the statement, so an unset input grants nothing."
  type = object({
    ecs_cluster_arn                = optional(string)
    service_arns                   = optional(list(string), [])
    migration_task_definition_arn  = optional(string)
    migration_passrole_arns        = optional(list(string), [])
    restore_task_definition_arn    = optional(string)
    restore_passrole_arns          = optional(list(string), [])
    restore_subnet_group_arn       = optional(string)
    restore_kms_key_arn            = optional(string)
    backup_vault_arn               = optional(string)
    audit_task_definition_arn      = optional(string)
    audit_passrole_arns            = optional(list(string), [])
    bootstrap_task_definition_arn  = optional(string)
    bootstrap_passrole_arns        = optional(list(string), [])
    recover_passrole_arns          = optional(list(string), [])
    ecr_repository_arns            = optional(list(string), [])
    signing_key_arn                = optional(string)
    secrets_kms_key_arn            = optional(string)
    release_manifest_bucket_arn    = optional(string)
    audit_bucket_arn               = optional(string)
    marketing_bucket_arns          = optional(map(string), {})
    marketing_distribution_arns    = optional(map(string), {})
    log_group_arns                 = optional(list(string), [])
    permission_boundary_policy_arn = optional(string)
    rehearsal_passrole_arns        = optional(list(string), [])
    workload_passrole              = optional(list(object({ arn = string, service = string })), [])
  })
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}
