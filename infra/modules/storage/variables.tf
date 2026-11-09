variable "name_prefix" {
  description = "Prefix for bucket names, for example ehr-prod. Buckets are <prefix>-docs-quarantine, <prefix>-docs-clean and <prefix>-docs-clean-replica."
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed key (primary Region) for both buckets. Use a multi-Region primary key so the replica key exists in the recovery Region."
  type        = string
}

variable "replica_kms_key_arn" {
  description = "Multi-Region replica key in the recovery Region, used for the replica bucket. Required when replication_enabled."
  type        = string
  default     = null
}

variable "replication_enabled" {
  description = "Replicate the clean bucket to the recovery Region with Replication Time Control (ARCHITECTURE 9.4). The quarantine bucket is never replicated."
  type        = bool
  default     = true
  validation {
    condition     = !var.replication_enabled || var.replica_kms_key_arn != null
    error_message = "replica_kms_key_arn is required when replication_enabled is true."
  }
}

variable "clean_writer_principal_arns" {
  description = "Only these principals (the scan-promotion role) may write to the clean bucket. Empty is rejected unless allow_unrestricted_clean_writers is true."
  type        = list(string)
  default     = []
}

variable "allow_unrestricted_clean_writers" {
  description = "Explicit opt-out of the clean-bucket writer restriction, for throwaway environments only. Never true in production."
  type        = bool
  default     = false
}

variable "quarantine_expiry_days" {
  description = "Objects left in quarantine are expired after this many days (uploads in progress are retried by the user)."
  type        = number
  default     = 7
}

variable "noncurrent_version_days" {
  description = "Noncurrent versions of clean documents are kept this long (DEVOPS-PLAN 10.1: 90 days; legal hold per policy)."
  type        = number
  default     = 90
}

variable "access_log_bucket" {
  description = "Bucket (in the log-archive account) that receives S3 server access logs. Null disables."
  type        = string
  default     = null
}

variable "force_destroy" {
  description = "Allow destroying non-empty buckets. Must stay false outside throwaway test environments."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
