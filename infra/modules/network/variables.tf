variable "name" {
  description = "Name prefix, for example prod or staging."
  type        = string
}

variable "cidr_block" {
  description = "VPC IPv4 CIDR. Must not overlap another environment (no peering is planned, but loadtest and restore-test share an account with staging/production)."
  type        = string
}

variable "az_count" {
  description = "Availability Zones used (at least 2; production uses 3 where the Region offers them)."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (DEVOPS-PLAN 3.2: at least two AZs)."
  }
}

variable "nat_per_az" {
  description = "One NAT gateway per AZ (production) or a single shared one (staging, marketing)."
  type        = bool
  default     = false
}

variable "flow_log_destination_arn" {
  description = "S3 bucket ARN (log-archive account) that receives VPC flow logs. Required: no VPC without flow logs."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
