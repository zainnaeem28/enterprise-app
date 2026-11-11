output "api_task_role_arn" {
  description = "Value for services.api.task_role_arn in the compute module. Known without the role existing (fixed name)."
  value       = "${local.role_arn_prefix}/${local.api_role_name}"
}

output "worker_task_role_arn" {
  description = "Value for services.worker.task_role_arn. Also the clean-bucket writer (storage module) and the anchor writer / reader (archive module)."
  value       = "${local.role_arn_prefix}/${local.worker_role_name}"
}

output "execution_role_arn" {
  description = "Value for execution_role_arn in the compute module."
  value       = "${local.role_arn_prefix}/${local.execution_role_name}"
}

output "api_environment" {
  description = "services.api.environment: every adapter variable of the api process."
  value       = local.api_environment
}

output "worker_environment" {
  description = "services.worker.environment: every adapter variable of the worker process."
  value       = local.worker_environment
}

output "api_secret_references" {
  description = "services.api.secret_references (none: the api reads secrets at run time through its role)."
  value       = {}
}

output "worker_secret_references" {
  description = "services.worker.secret_references: the VAPID private key is injected by secret name."
  value       = { EHR_VAPID_PRIVATE_KEY = var.vapid_private_key_secret_name }
}

output "payload_key_arn" {
  value = aws_kms_key.payload.arn
}

output "ses_identity_arn" {
  description = "Identity for the identity module's ses_source_arn."
  value       = aws_sesv2_email_identity.domain.arn
}

output "ses_dkim_tokens" {
  description = "CNAME tokens to publish in DNS (a go-live step)."
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

output "package_bucket_name" {
  value = aws_s3_bucket.this["packages"].id
}

output "export_bucket_name" {
  value = aws_s3_bucket.this["exports"].id
}

output "guardduty_plan_arn" {
  value = aws_guardduty_malware_protection_plan.quarantine.arn
}

output "payload_key_policy_json" {
  description = "Key policy of the payload key, reused for its recovery-Region replica."
  value       = data.aws_iam_policy_document.payload_key.json
}

output "ses_configuration_set_name" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "recovery_ses_dkim_tokens" {
  description = "CNAME tokens of the recovery-Region SES identity (a go-live DNS step); empty without recovery_region."
  value       = one(aws_sesv2_email_identity.recovery[*].dkim_signing_attributes[0].tokens)
}

output "recovery_environment" {
  description = "Environment overrides for the recovery-Region task definitions (docs/runbooks/recovery-region.md); null without recovery_region. Merge over api_environment / worker_environment. The anchor archive variables are left out on purpose: the anchor archive is a degraded mode there."
  value = local.recovery_enabled ? {
    common = {
      AWS_REGION                    = local.rr
      EHR_SECRETS_KMS_KEY_ID        = local.rr_secrets_key
      EHR_KMS_PAYLOAD_KEY_ID        = local.rr_payload_key_arn
      EHR_S3_DOCS_QUARANTINE_BUCKET = local.rr_bucket_names["quarantine"]
      EHR_S3_DOCS_CLEAN_BUCKET      = reverse(split(":::", local.rr_docs_bucket))[0]
      EHR_S3_DOCS_KMS_KEY_ID        = local.rr_data_key
      EHR_S3_PACKAGE_BUCKET         = local.rr_bucket_names["packages"]
      EHR_S3_PACKAGE_KMS_KEY_ID     = local.rr_data_key
    }
    worker = merge(
      {
        EHR_S3_EXPORT_BUCKET     = local.rr_bucket_names["exports"]
        EHR_S3_EXPORT_KMS_KEY_ID = local.rr_data_key
      },
      local.rr_sms_enabled ? {
        EHR_SMS_ORIGINATION_IDENTITY = var.recovery_sms_origination_identity_arn
        EHR_SMS_CONFIGURATION_SET    = "${var.env}-ehr-sms"
      } : {},
    )
    worker_unset = concat(
      ["EHR_S3_ANCHOR_ARCHIVE_BUCKET", "EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID"],
      local.rr_sms_enabled ? [] : ["EHR_SMS_ORIGINATION_IDENTITY", "EHR_SMS_CONFIGURATION_SET"],
    )
  } : null
}
