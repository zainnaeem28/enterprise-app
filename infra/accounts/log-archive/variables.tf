variable "organization_id" {
  type = string
}

variable "flow_log_bucket_name" {
  description = "Globally unique bucket name receiving VPC flow logs from every account in the organisation."
  type        = string
}

variable "retention_days" {
  description = "Flow-log retention. ASSUMPTION: 400 days pending the retention decision in the compliance requirements; do not treat as approved."
  type        = number
  default     = 400
}
