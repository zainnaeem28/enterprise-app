variable "flow_log_bucket_arn" {
  description = "Flow-log bucket ARN from the log-archive root."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
