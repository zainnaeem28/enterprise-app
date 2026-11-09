variable "alias" {
  description = "Alias name without the alias/ prefix, for example prod-rds."
  type        = string
}

variable "description" {
  description = "What the key protects."
  type        = string
}

variable "usage_principal_arns" {
  description = "IAM principals allowed to use (not administer) the key."
  type        = list(string)
  default     = []
}

variable "service_principals" {
  description = "AWS service principals allowed to use the key, restricted to this account."
  type        = list(string)
  default     = []
}

variable "service_source_org_id" {
  description = "When set, service principals are restricted to this organisation (aws:SourceOrgID) instead of this account. Used by the log-archive key, which receives deliveries from other accounts."
  type        = string
  default     = null
}

variable "cross_account_decrypt_arns" {
  description = "Principals in other accounts that need key use (for example backup or replication roles)."
  type        = list(string)
  default     = []
}

variable "multi_region" {
  description = "Create a multi-Region primary key so a replica can exist in the recovery Region."
  type        = bool
  default     = false
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled deletion takes effect."
  type        = number
  default     = 30
  validation {
    condition     = var.deletion_window_in_days >= 7 && var.deletion_window_in_days <= 30
    error_message = "deletion_window_in_days must be 7 to 30."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
