variable "name" {
  description = "Name prefix, for example staging or production."
  type        = string
}

variable "patient_auth_domain" {
  description = "Custom auth domain of the patient pool, for example auth.example.org. It is also the passkey relying-party ID (WebAuthn RP ID). Set it correctly before go-live: changing it later forces every patient to register their passkeys again, and the recovery-Region replica depends on the same value (ARCHITECTURE 9.4)."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.patient_auth_domain))
    error_message = "patient_auth_domain must be a lower-case fully qualified domain name."
  }
}

variable "partner_auth_domain" {
  description = "Custom auth domain of the partner (pharmacy) pool. A different host from the patient domain: separate realms."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.partner_auth_domain))
    error_message = "partner_auth_domain must be a lower-case fully qualified domain name."
  }
}

variable "domain_certificate_arn" {
  description = "ACM certificate in us-east-1 that covers both auth domains (Cognito custom domains are served by CloudFront)."
  type        = string
}

variable "ses_source_arn" {
  description = "Verified SES identity used for email OTP, verification and MFA mail. Required: Cognito's default sender is capped and not for production."
  type        = string
}

variable "ses_from_address" {
  description = "From address, on the verified SES identity."
  type        = string
}

variable "ses_configuration_set" {
  description = "SES configuration set for delivery metrics. Optional."
  type        = string
  default     = null
}

variable "sms_caller_role_arn" {
  description = "IAM role Cognito assumes to publish SMS through SNS. IAM is owned by the approvals root (DEVOPS-PLAN 7.5), so this module only references the role. Leaving the SNS account in the SMS sandbox is an operator item: SMS fallback does not reach real numbers until the sandbox is exited."
  type        = string
}

variable "sms_external_id" {
  description = "External ID in the SMS role's trust policy (confused-deputy protection)."
  type        = string
}

variable "region" {
  description = "Region of the user pools (used to build the OIDC issuer URL)."
  type        = string
  default     = "us-east-2"
}

variable "sms_region" {
  description = "Region of the SNS service used for SMS."
  type        = string
  default     = null
}

variable "patient_callback_urls" {
  description = "OAuth redirect URIs for the patient app client (the API's /auth/callback on the my. host)."
  type        = list(string)
  validation {
    condition     = length(var.patient_callback_urls) > 0 && alltrue([for u in var.patient_callback_urls : startswith(u, "https://")])
    error_message = "patient_callback_urls must be non-empty and https only."
  }
}

variable "patient_logout_urls" {
  type = list(string)
  validation {
    condition     = alltrue([for u in var.patient_logout_urls : startswith(u, "https://")])
    error_message = "patient_logout_urls must be https only."
  }
}

variable "partner_callback_urls" {
  type = list(string)
  validation {
    condition     = length(var.partner_callback_urls) > 0 && alltrue([for u in var.partner_callback_urls : startswith(u, "https://")])
    error_message = "partner_callback_urls must be non-empty and https only."
  }
}

variable "partner_logout_urls" {
  type = list(string)
  validation {
    condition     = alltrue([for u in var.partner_logout_urls : startswith(u, "https://")])
    error_message = "partner_logout_urls must be https only."
  }
}

variable "passkey_user_verification" {
  description = "WebAuthn user verification. The approved card (decision HEAAA-172) uses preferred. 'required' belongs to the proposed amendment DEV-PP04-B (passkey counts as MFA) and is refused until dev_pp04_b_endorsed is true."
  type        = string
  default     = "preferred"
  validation {
    condition     = contains(["preferred", "required"], var.passkey_user_verification)
    error_message = "passkey_user_verification must be preferred or required."
  }
}

variable "dev_pp04_b_endorsed" {
  description = "Set true only after a human endorses G2 amendment DEV-PP04-B. Until then passkey_user_verification must stay preferred. The provider (aws 5.100) cannot express FactorConfiguration = MULTI_FACTOR_WITH_USER_VERIFICATION, so even then that part is a follow-up."
  type        = bool
  default     = false
}

variable "patient_totp_enabled" {
  description = "Offer TOTP as an MFA method to patients. Off by default: TOTP does not work in the replica Region (ARCHITECTURE section 7), and with MFA optional a user who enables classic MFA can afterwards sign in with a password only."
  type        = bool
  default     = false
}

variable "partner_totp_enabled" {
  description = "Offer TOTP to partner users. Off by default for the same replica reason; email OTP is the mandatory second factor."
  type        = bool
  default     = false
}

variable "access_token_minutes" {
  type    = number
  default = 10
}

variable "id_token_minutes" {
  type    = number
  default = 10
}

variable "refresh_token_days" {
  type    = number
  default = 1
}

variable "deletion_protection" {
  description = "ACTIVE for staging and production pools; INACTIVE only for ephemeral rehearsal stacks."
  type        = string
  default     = "ACTIVE"
  validation {
    condition     = contains(["ACTIVE", "INACTIVE"], var.deletion_protection)
    error_message = "deletion_protection must be ACTIVE or INACTIVE."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
