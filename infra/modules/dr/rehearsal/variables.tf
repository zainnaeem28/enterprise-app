variable "name" {
  description = "Name prefix. Must start with dr- so the stack cannot be mistaken for, or collide with, an environment."
  type        = string
  default     = "dr-rehearsal"
}

variable "expected_account_id" {
  description = "The staging account ID. The plan fails in any other account (the rehearsal never runs in production, DEVOPS-PLAN 3.5, 10.4)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit account ID."
  }
}

variable "expected_region" {
  description = "The recovery Region. The plan fails anywhere else."
  type        = string
  default     = "us-west-2"
}

variable "vpc_cidr" {
  description = "CIDR of the rehearsal VPC (disjoint from staging, production, loadtest and restore-test)."
  type        = string
}

variable "flow_log_destination_arn" {
  description = "S3 bucket ARN for VPC flow logs. Required by the network module: no VPC without flow logs."
  type        = string
}

variable "snapshot_arn" {
  description = "ARN of the cross-Region copy of the SYNTHETIC loadtest snapshot in the recovery Region. The snapshot name must contain -synthetic-: a snapshot of anything else is refused."
  type        = string
}

variable "db_instance_class" {
  description = "Instance class of the restored database. Cost of one rehearsal day is an estimate in DEVOPS-PLAN 10.4, not a measurement."
  type        = string
  default     = "db.r6g.large"
}

variable "expires_at" {
  description = "RFC 3339 time after which the sweep in scripts/restore/dr-rehearsal.sh destroys this stack. At most 24 h after creation (checked by the script, which knows the clock)."
  type        = string
  validation {
    condition     = can(formatdate("YYYY-MM-DD", var.expires_at))
    error_message = "expires_at must be an RFC 3339 timestamp."
  }
}

variable "rehearsal_id" {
  description = "Run identifier tagged on every resource (lowercase letters, digits, hyphens)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,30}$", var.rehearsal_id))
    error_message = "rehearsal_id must be 3-31 characters of lowercase letters, digits and hyphens."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
