variable "organization_id" {
  type = string
}

variable "flow_log_bucket_name" {
  description = "Globally unique bucket name receiving VPC flow logs from every account in the organisation."
  type        = string
}

variable "retention_days" {
  description = "Network flow-log retention: 1 year (owner ruling C item 2; † counsel confirmation pending; infra/RETENTION.md)."
  type        = number
  default     = 365
  validation {
    condition     = var.retention_days >= 365
    error_message = "retention_days must be at least 365 (flow logs are kept 1 year)."
  }
}
