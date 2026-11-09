variable "primary_region" {
  type    = string
  default = "us-east-2" # DEVOPS-PLAN 3.3 (Recommendation)
}

variable "recovery_region" {
  type    = string
  default = "us-west-2"
}

variable "state_bucket_name" {
  description = "Globally unique name of the Terraform state bucket in the tooling account."
  type        = string
}

variable "organization_id" {
  description = "AWS Organizations ID (o-...). Account roots read and write state only from inside the organisation."
  type        = string
}

variable "state_access_role_arns" {
  description = "Roles allowed to read and write state objects (the per-account gh-tf-* roles and platform-admin-apply). The approvals root has its own bucket and is NOT listed here (DEVOPS-PLAN 7.5)."
  type        = list(string)
}

variable "platform_admin_role_arn" {
  description = "platform-admin-apply role ARN pattern, the only principal allowed to administer the bucket and key."
  type        = string
}
