variable "account_emails" {
  description = "Unique root e-mail address per member account. Owners are supplied by the account-owner decision (DEVOPS-PLAN 16); no value is assumed."
  type = object({
    tooling     = string
    log_archive = string
    staging     = string
    production  = string
    marketing   = string
  })
}

variable "primary_region" {
  type    = string
  default = "us-east-2"
}

variable "recovery_region" {
  type    = string
  default = "us-west-2"
}

variable "platform_admin_role_arn_pattern" {
  description = "ARN pattern of the IAM Identity Center permission-set role platform-admin-apply (the only principal exempt from the control-plane SCP). Identity Center roles live under aws-reserved/sso.amazonaws.com."
  type        = string
  default     = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_platform-admin-apply_*"
}

variable "attach_scps" {
  description = "Attach the SCPs to their OUs. Defaults to false: the region-deny SCP must not be attached until the us-east-1 exemption list is verified on the build date (C-12, DEVOPS-PLAN 3.3)."
  type        = bool
  default     = false
}
