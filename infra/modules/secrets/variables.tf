variable "env" {
  description = "Environment name used as the secret-name prefix (staging, production)."
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed key of the secrets (the env 'secrets' key from the account root)."
  type        = string
}

variable "organization_id" {
  description = "AWS Organizations ID. Every secret refuses principals outside the organisation."
  type        = string
}

variable "secrets" {
  description = <<-E
    Secret containers by path under the environment prefix, for example "db/app_owner".
    readers: role ARNs that may read the value. writers: role ARNs that may write a new value
    (normally only the rotation function). No value is ever set by this module.
  E
  type = map(object({
    description = string
    readers     = list(string)
    writers     = optional(list(string), [])
  }))
  validation {
    condition     = alltrue([for k, s in var.secrets : length(s.readers) > 0 && alltrue([for a in concat(s.readers, s.writers) : startswith(a, "arn:aws:iam::")])])
    error_message = "Every secret needs at least one reader, and readers and writers must be IAM role ARNs."
  }
  validation {
    condition     = alltrue([for k, s in var.secrets : !startswith(k, "integration/")])
    error_message = "integration/outbound/* and integration/inbound/* secrets are created at runtime by the application roles (DEVOPS-PLAN 7.2) and are not containers in IaC."
  }
}

variable "break_glass_role_arns" {
  description = "bg-* roles that may read secrets during a declared recovery (named humans via Identity Center; every use alerts)."
  type        = list(string)
  default     = []
}

variable "rotation_lambda_arn" {
  description = "Rotation function. When null no rotation is scheduled and the evidence says so."
  type        = string
  default     = null
}

variable "rotation_days" {
  description = "Rotation interval (DEVOPS-PLAN 7.2: each release or 90 days)."
  type        = number
  default     = 90
  validation {
    condition     = var.rotation_days >= 1 && var.rotation_days <= 90
    error_message = "rotation_days must be 1 to 90."
  }
}

variable "recovery_region" {
  description = "Recovery Region for secret replicas. Null = no replica."
  type        = string
  default     = null
}

variable "replica_kms_key_arn" {
  description = "Replica of the multi-Region secrets key in the recovery Region. Required when recovery_region is set."
  type        = string
  default     = null
}

variable "recovery_window_in_days" {
  type    = number
  default = 30
  validation {
    condition     = var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30
    error_message = "recovery_window_in_days must be 7 to 30 (no immediate deletion)."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
