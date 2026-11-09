variable "name" {
  description = "Name prefix for every resource of the restore-test boundary."
  type        = string
  default     = "restore-test"
}

variable "vpc_cidr" {
  description = "CIDR of the isolated restore VPC. Must not overlap another environment (no peering exists, but the ranges are kept disjoint)."
  type        = string
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 22
    error_message = "vpc_cidr must be a valid CIDR no larger than /22: the boundary needs two small private subnets and a few endpoint interfaces."
  }
}

variable "flow_log_destination_arn" {
  description = "S3 bucket ARN (log-archive account) for VPC flow logs. Required: no VPC without flow logs."
  type        = string
}

variable "result_bucket_name" {
  description = "Bucket in the log-archive account that receives the PHI-free result documents under restore-test/results/. The task may also read restore-test/baseline/."
  type        = string
}

variable "result_bucket_kms_key_arn" {
  description = "KMS key of the result bucket (log-archive account); the task role may only GenerateDataKey and Decrypt with it."
  type        = string
}

variable "ecr_repository_arn" {
  description = "ECR repository holding the pinned image. The ECR endpoint policy and the execution role allow this repository only."
  type        = string
}

variable "image_repository_url" {
  description = "Repository URL of the pinned image, without tag or digest."
  type        = string
}

variable "image_digest" {
  description = "Digest of the image from the release manifest (sha256:<64 hex>). A tag is refused: the task definition is pinned by digest (DEVOPS-PLAN 7.5)."
  type        = string
  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be sha256:<64 lowercase hex>, copied from the release manifest."
  }
}

variable "rds_ca_bundle_path" {
  description = "Path of the RDS CA bundle inside the image; the task refuses a connection it cannot verify."
  type        = string
  default     = "/app/certs/rds-global-bundle.pem"
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 4096
}

variable "log_retention_days" {
  description = "Retention of the task log group. The logs hold counts and codes only."
  type        = number
  default     = 90
}

variable "alert_topic_arn" {
  description = "SNS topic (observability `security` route) told about every restore API call so one outside the monthly window is seen. Null creates the rule without a target and the plan says so."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
