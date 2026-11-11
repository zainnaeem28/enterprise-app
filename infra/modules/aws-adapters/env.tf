# The environment and secret references of the two services (compute module `services[*].environment` and
# `.secret_references`). Names are the ones in docs/runbooks/AWS-ADAPTERS.md. A group is either complete or
# absent: the application refuses a partial group at start, so nothing here is partly set. The emulator-only
# variables (EHR_AWS_ENDPOINT_URL, EHR_AWS_S3_FORCE_PATH_STYLE, static keys) are never set: the task role is used.

locals {
  oidc_domain = "https://${var.patient_auth_domain}"

  common_environment = {
    AWS_REGION                    = local.region
    EHR_SECRETS_PREFIX            = var.env
    EHR_SECRETS_KMS_KEY_ID        = var.secrets_kms_key_arn
    EHR_KMS_PAYLOAD_KEY_ID        = aws_kms_key.payload.arn
    EHR_S3_DOCS_QUARANTINE_BUCKET = var.docs_quarantine_bucket_name
    EHR_S3_DOCS_CLEAN_BUCKET      = var.docs_clean_bucket_name
    EHR_S3_DOCS_KMS_KEY_ID        = var.data_kms_key_arn
    EHR_S3_PACKAGE_BUCKET         = aws_s3_bucket.this["packages"].id
    EHR_S3_PACKAGE_KMS_KEY_ID     = var.data_kms_key_arn
    EHR_CHIME_MEDIA_REGION        = var.chime_media_region
  }

  api_environment = merge(var.extra_environment, local.common_environment, {
    EHR_PATIENT_OIDC_ISSUER                 = var.patient_oidc_issuer
    EHR_PATIENT_OIDC_JWKS_URI               = "${var.patient_oidc_issuer}/.well-known/jwks.json"
    EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT = "${local.oidc_domain}/oauth2/authorize"
    EHR_PATIENT_OIDC_TOKEN_ENDPOINT         = "${local.oidc_domain}/oauth2/token"
    EHR_PATIENT_OIDC_CLIENT_ID              = var.patient_oidc_client_id
    EHR_PATIENT_OIDC_REDIRECT_URI           = var.patient_oidc_redirect_uri
    },
    local.receipts_enabled ? {
      EHR_SNS_RECEIPT_REGION = local.region
      EHR_SNS_RECEIPT_TOPICS = join(",", [for k, t in aws_sns_topic.receipts : "${t.arn}=${k}"])
    } : {},
  )

  worker_environment = merge(
    var.extra_environment,
    local.common_environment,
    {
      EHR_S3_EXPORT_BUCKET             = aws_s3_bucket.this["exports"].id
      EHR_S3_EXPORT_KMS_KEY_ID         = var.data_kms_key_arn
      EHR_S3_ANCHOR_ARCHIVE_BUCKET     = var.anchor_archive_bucket_name
      EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID = var.anchor_archive_kms_key_arn
      EHR_SES_FROM_ADDRESS             = var.ses_from_address
      EHR_SES_CONFIGURATION_SET        = aws_sesv2_configuration_set.this.configuration_set_name
      EHR_SECURITY_CONTACT_EMAIL       = var.security_contact_email
      EHR_VAPID_PUBLIC_KEY             = var.vapid_public_key
      EHR_VAPID_SUBJECT                = var.vapid_subject
      EHR_MALWARE_SCAN                 = "guardduty"
      EHR_OCR                          = "textract"
    },
    length(var.payload_previous_key_arns) == 0 ? {} : { EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS = join(",", var.payload_previous_key_arns) },
    local.sms_enabled ? {
      EHR_SMS_ORIGINATION_IDENTITY = var.sms_origination_identity_arn
      EHR_SMS_CONFIGURATION_SET    = aws_pinpointsmsvoicev2_configuration_set.this.name
    } : {},
  )
}
