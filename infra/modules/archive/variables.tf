variable "name_prefix" {
  description = "Prefix for resource names, for example ehr-logarchive."
  type        = string
}

variable "organization_id" {
  description = "AWS Organizations ID. Writers and backup copies are accepted only from inside this organisation."
  type        = string
}

variable "kms_key_arn" {
  description = "Log-archive key (primary Region) for the archive bucket and the primary backup vault."
  type        = string
}

variable "replica_kms_key_arn" {
  description = "Key in the recovery Region for the archive replica and the recovery-Region vault."
  type        = string
}

variable "retention_days" {
  description = "Object Lock default retention in days: audit trail and anchors 7 years (2557 days, owner ruling C item 2; † counsel confirmation pending; see infra/RETENTION.md). The HIPAA documentation period (6 years) is shorter and is covered by this period. Compliance-mode retention cannot be shortened or removed once objects are written."
  type        = number
  default     = 2557
  validation {
    condition     = var.retention_days >= 1
    error_message = "retention_days must be at least 1."
  }
  validation {
    condition     = var.object_lock_mode != "COMPLIANCE" || var.retention_days >= 2557
    error_message = "retention_days must be at least 2557 (7 years) in COMPLIANCE mode; only a throwaway GOVERNANCE environment may use less."
  }
}

variable "object_lock_mode" {
  description = "COMPLIANCE for production. GOVERNANCE only for a throwaway environment."
  type        = string
  default     = "COMPLIANCE"
  validation {
    condition     = contains(["COMPLIANCE", "GOVERNANCE"], var.object_lock_mode)
    error_message = "object_lock_mode must be COMPLIANCE or GOVERNANCE."
  }
}

variable "writer_principal_arns" {
  description = "Roles that may add objects under partitions/ (the worker's audit archiver in the production account). PutObject on partitions/* and list under that prefix only; never delete. May be empty."
  type        = list(string)
  default     = []
}

variable "anchor_writer_principal_arns" {
  description = "Roles that may add objects under anchors/ (the worker task role, which archives audit anchors). PutObject on anchors/* only; no retention, legal-hold or delete actions."
  type        = list(string)
  default     = []
}

variable "anchor_reader_principal_arns" {
  description = "Roles that may read anchors/ (the worker's verification job): GetObject, GetObjectVersion and list versions under anchors/ only."
  type        = list(string)
  default     = []
}

variable "reader_principal_arns" {
  description = "Roles that may read the whole archive (auditors)."
  type        = list(string)
  default     = []
}

variable "legal_hold_principal_arns" {
  description = "Roles that may place or lift legal holds. Empty means nobody can."
  type        = list(string)
  default     = []
}

variable "vault_min_retention_days" {
  description = "Backup vault lock: shortest retention any recovery point may be given."
  type        = number
  default     = 35
}

variable "vault_max_retention_days" {
  description = "Backup vault lock: longest retention (monthly points are kept 12 months, DEVOPS-PLAN 10.1)."
  type        = number
  default     = 400
}

variable "vault_lock_changeable_for_days" {
  description = "Cooling-off period before the vault lock becomes immutable (compliance mode, minimum 3). Null leaves the lock in governance mode, for throwaway environments only."
  type        = number
  default     = 7
  validation {
    condition     = var.vault_lock_changeable_for_days == null || coalesce(var.vault_lock_changeable_for_days, 3) >= 3
    error_message = "vault_lock_changeable_for_days must be null or at least 3."
  }
}

variable "recovery_vault_enabled" {
  description = "Also create a vault-locked vault in the recovery Region, so backup copies survive loss of the primary Region."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Never true in production; Object Lock refuses it anyway."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
