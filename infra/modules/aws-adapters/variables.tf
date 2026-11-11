variable "env" {
  description = "Environment name (staging or production). Prefix of role names and of the secret names (EHR_SECRETS_PREFIX)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env is staging or production."
  }
}

variable "compute_name" {
  description = "The name given to the compute module (log groups are /ecs/<compute_name>/<service>). Scopes the execution role's log permissions."
  type        = string
}

variable "data_kms_key_arn" {
  description = "Data key of the account (documents, privacy packages, audit exports). EHR_S3_*_KMS_KEY_ID is this ARN."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "Secrets key of the account. Used for secrets the application creates (EHR_SECRETS_KMS_KEY_ID) and read by the execution role."
  type        = string
}

variable "payload_key_multi_region" {
  description = "Create the payload sealing key as a multi-Region primary so a replica can exist in the recovery Region (sealed jobs must stay openable after a failover)."
  type        = bool
  default     = false
}

variable "docs_quarantine_bucket_name" {
  description = "Name of the quarantine bucket made by the storage module (<prefix>-docs-quarantine). A name, not an ARN, so the storage module can take the worker role without a dependency cycle."
  type        = string
}

variable "docs_clean_bucket_name" {
  description = "Name of the clean bucket made by the storage module (<prefix>-docs-clean)."
  type        = string
}

variable "bucket_name_prefix" {
  description = "Prefix of the buckets created here: <prefix>-privacy-packages and <prefix>-audit-exports."
  type        = string
}

variable "package_expiry_days" {
  description = "Privacy export packages are short-lived downloads: 7 days (owner ruling C item 2 †, counsel confirmation pending; infra/RETENTION.md)."
  type        = number
  default     = 7
  validation {
    condition     = var.package_expiry_days >= 1
    error_message = "package_expiry_days must be at least 1."
  }
}

variable "export_expiry_days" {
  description = "Audit export objects are copies; the audit archive is the record. Not covered by owner ruling C item 2: 90 days is unchanged and still unconfirmed (infra/RETENTION.md)."
  type        = number
  default     = 90
}

variable "access_log_bucket" {
  description = "Bucket (log-archive account) that receives S3 server access logs for the buckets made here. Null disables."
  type        = string
  default     = null
}

variable "force_destroy" {
  description = "Never true outside throwaway environments."
  type        = bool
  default     = false
}

variable "anchor_archive_bucket_name" {
  description = "Object Lock audit-anchor bucket in the log-archive account (EHR_S3_ANCHOR_ARCHIVE_BUCKET). The bucket policy that admits the worker is in the archive module (anchor_writer_principal_arns, anchor_reader_principal_arns)."
  type        = string
}

variable "anchor_archive_kms_key_arn" {
  description = "Key of that bucket in the log-archive account (EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID). Its key policy must admit the worker role (archive account root: cross_account_decrypt_arns)."
  type        = string
}

variable "ses_domain" {
  description = "Domain verified in SES for sending (DKIM identity)."
  type        = string
}

variable "ses_from_address" {
  description = "From address on that domain (EHR_SES_FROM_ADDRESS)."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.ses_from_address))
    error_message = "ses_from_address must be an e-mail address."
  }
}

variable "security_contact_email" {
  description = "Mailbox for security notices (EHR_SECURITY_CONTACT_EMAIL). Configuration, not a secret."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.security_contact_email))
    error_message = "security_contact_email must be an e-mail address."
  }
}

variable "sms_origination_identity_arn" {
  description = "ARN of the End User Messaging phone number, pool or sender ID the SMS adapter sends from (EHR_SMS_ORIGINATION_IDENTITY). Acquiring and registering one is a purchase and a registration with carriers, so it is an input; null leaves SMS unconfigured and the application refuses SMS."
  type        = string
  default     = null
}

variable "vapid_public_key" {
  description = "Web Push VAPID public key (EHR_VAPID_PUBLIC_KEY). Public by design."
  type        = string
}

variable "vapid_subject" {
  description = "mailto: or https: contact for push services (EHR_VAPID_SUBJECT)."
  type        = string
  validation {
    condition     = startswith(var.vapid_subject, "mailto:") || startswith(var.vapid_subject, "https://")
    error_message = "vapid_subject is a mailto: or https: URI."
  }
}

variable "vapid_private_key_secret_name" {
  description = "Name of the Secrets Manager secret holding the VAPID private key (a container made with the secrets module, value entered by an operator). Injected into the worker task as EHR_VAPID_PRIVATE_KEY by name; it is never a value here."
  type        = string
}

variable "chime_media_region" {
  description = "Chime SDK media region (EHR_CHIME_MEDIA_REGION)."
  type        = string
  default     = "us-east-1"
}

variable "patient_oidc_issuer" {
  description = "Issuer of the patient Cognito pool (identity module output patient_issuer)."
  type        = string
}

variable "patient_oidc_client_id" {
  type = string
}

variable "patient_auth_domain" {
  description = "Custom auth domain of the patient pool (authorize and token endpoints)."
  type        = string
}

variable "patient_oidc_redirect_uri" {
  type = string
  validation {
    condition     = startswith(var.patient_oidc_redirect_uri, "https://")
    error_message = "patient_oidc_redirect_uri must be https."
  }
}

variable "ecr_repository_arns" {
  description = "ECR repositories the execution role may pull from."
  type        = list(string)
  validation {
    condition     = length(var.ecr_repository_arns) > 0
    error_message = "At least one repository."
  }
}

variable "execution_secret_names" {
  description = "Names of the Secrets Manager secrets the execution role injects into containers (the VAPID secret and the database credentials of the api and worker)."
  type        = list(string)
}

variable "extra_environment" {
  description = "Further non-secret environment variables merged into both services (for example database host). Cannot override an adapter variable."
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "payload_previous_key_arns" {
  description = "Payload keys whose old sealed blobs the worker may still open after a rotation (EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS). Keys in the account or the recovery Region."
  type        = list(string)
  default     = []
}

variable "alarm_topic_arns" {
  description = "SNS topics (observability module) that receive the video-vendor failure alarm."
  type        = list(string)
  validation {
    condition     = length(var.alarm_topic_arns) > 0
    error_message = "An alarm needs at least one topic."
  }
}

variable "video_failure_threshold" {
  description = "Failed video vendor calls in 5 minutes that raise the alarm. PLACEHOLDER, not a tuned value."
  type        = number
  default     = 5
}

# ---- recovery Region (no compute exists there; policies only) ----

variable "recovery_region" {
  description = "Recovery Region (for example us-west-2). When set, the three task roles may be assumed by ECS tasks of this Region and get a second inline policy naming the recovery-Region replicas. No compute is created either way. Null keeps the roles primary-Region only."
  type        = string
  default     = null
}

variable "recovery_data_kms_key_arn" {
  description = "Replica of the data key in the recovery Region (aws_kms_replica_key). Required with recovery_region."
  type        = string
  default     = null
}

variable "recovery_secrets_kms_key_arn" {
  description = "Key that encrypts the replicas of the secrets in the recovery Region (not a replica key: Secrets Manager takes any key of that Region). Required with recovery_region."
  type        = string
  default     = null
}

variable "recovery_docs_clean_bucket_arn" {
  description = "Recovery-Region replica of the clean documents bucket (storage module output replica_bucket_arn). Required with recovery_region."
  type        = string
  default     = null
}

variable "recovery_quarantine_expiry_days" {
  description = "Objects left in the recovery-Region quarantine bucket are expired after this many days (same default as the storage module)."
  type        = number
  default     = 7
}

variable "recovery_sms_origination_identity_arn" {
  description = "End User Messaging phone number, pool or sender ID in the RECOVERY Region (identities are per Region; acquiring one is a purchase and a carrier registration, so it is an input). Null leaves SMS out of the recovery Region: SMS is the documented degraded mode (docs/runbooks/recovery-region.md)."
  type        = string
  default     = null
}
