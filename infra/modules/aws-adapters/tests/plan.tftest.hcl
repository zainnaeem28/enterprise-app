mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-2" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock", id = "mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-2:111111111111:key/payload" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_sesv2_email_identity" {
    defaults = { arn = "arn:aws:ses:us-east-2:111111111111:identity/example.org" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-2:111111111111:mock-topic" }
  }
  mock_resource "aws_pinpointsmsvoicev2_configuration_set" {
    defaults = { arn = "arn:aws:sms-voice:us-east-2:111111111111:configuration-set/staging-ehr-sms" }
  }
}

mock_provider "aws" {
  alias = "recovery"
}

variables {
  env                           = "staging"
  compute_name                  = "ehr-staging"
  data_kms_key_arn              = "arn:aws:kms:us-east-2:111111111111:key/data"
  secrets_kms_key_arn           = "arn:aws:kms:us-east-2:111111111111:key/secrets"
  docs_quarantine_bucket_name   = "ehr-staging-docs-quarantine"
  docs_clean_bucket_name        = "ehr-staging-docs-clean"
  bucket_name_prefix            = "ehr-staging"
  anchor_archive_bucket_name    = "ehr-logarchive-audit-archive"
  anchor_archive_kms_key_arn    = "arn:aws:kms:us-east-2:222222222222:key/archive"
  ses_domain                    = "example.org"
  ses_from_address              = "no-reply@example.org"
  security_contact_email        = "security@example.org"
  sms_origination_identity_arn  = "arn:aws:sms-voice:us-east-2:111111111111:phone-number/phone-0000"
  vapid_public_key              = "BPublicKeyPublicKeyPublicKeyPublicKeyPublicKey"
  vapid_subject                 = "mailto:ops@example.org"
  vapid_private_key_secret_name = "staging/app/vapid_private_key"
  patient_oidc_issuer           = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_abc"
  patient_oidc_client_id        = "client"
  patient_auth_domain           = "auth.example.org"
  patient_oidc_redirect_uri     = "https://my.example.org/api/auth/callback"
  ecr_repository_arns           = ["arn:aws:ecr:us-east-2:111111111111:repository/ehr-api"]
  alarm_topic_arns              = ["arn:aws:sns:us-east-2:111111111111:alerts"]
  execution_secret_names        = ["staging/app/vapid_private_key"]
}

# The names the application reads (docs/runbooks/AWS-ADAPTERS.md). A rename in the runbook or the code that is not
# repeated here fails this test, and so does a variable missing from one process.
run "every_adapter_variable_reaches_the_right_process" {
  command = plan

  assert {
    condition = alltrue([for k in [
      "AWS_REGION", "EHR_SECRETS_PREFIX", "EHR_SECRETS_KMS_KEY_ID", "EHR_KMS_PAYLOAD_KEY_ID",
      "EHR_S3_DOCS_QUARANTINE_BUCKET", "EHR_S3_DOCS_CLEAN_BUCKET", "EHR_S3_DOCS_KMS_KEY_ID",
      "EHR_S3_PACKAGE_BUCKET", "EHR_S3_PACKAGE_KMS_KEY_ID", "EHR_CHIME_MEDIA_REGION",
      "EHR_PATIENT_OIDC_ISSUER", "EHR_PATIENT_OIDC_JWKS_URI", "EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT",
      "EHR_PATIENT_OIDC_TOKEN_ENDPOINT", "EHR_PATIENT_OIDC_CLIENT_ID", "EHR_PATIENT_OIDC_REDIRECT_URI",
    ] : contains(keys(output.api_environment), k)])
    error_message = "api environment is missing an adapter variable"
  }

  assert {
    condition = alltrue([for k in [
      "AWS_REGION", "EHR_SECRETS_PREFIX", "EHR_SECRETS_KMS_KEY_ID", "EHR_KMS_PAYLOAD_KEY_ID",
      "EHR_S3_DOCS_QUARANTINE_BUCKET", "EHR_S3_DOCS_CLEAN_BUCKET", "EHR_S3_DOCS_KMS_KEY_ID",
      "EHR_S3_PACKAGE_BUCKET", "EHR_S3_PACKAGE_KMS_KEY_ID", "EHR_S3_EXPORT_BUCKET", "EHR_S3_EXPORT_KMS_KEY_ID",
      "EHR_S3_ANCHOR_ARCHIVE_BUCKET", "EHR_S3_ANCHOR_ARCHIVE_KMS_KEY_ID",
      "EHR_SES_FROM_ADDRESS", "EHR_SES_CONFIGURATION_SET", "EHR_SECURITY_CONTACT_EMAIL",
      "EHR_SMS_ORIGINATION_IDENTITY", "EHR_SMS_CONFIGURATION_SET",
      "EHR_VAPID_PUBLIC_KEY", "EHR_VAPID_SUBJECT", "EHR_CHIME_MEDIA_REGION", "EHR_MALWARE_SCAN", "EHR_OCR",
    ] : contains(keys(output.worker_environment), k)])
    error_message = "worker environment is missing an adapter variable"
  }

  assert {
    condition     = output.worker_environment["EHR_MALWARE_SCAN"] == "guardduty" && output.worker_environment["EHR_OCR"] == "textract"
    error_message = "scan and OCR selectors"
  }

  assert {
    condition     = keys(output.worker_secret_references) == ["EHR_VAPID_PRIVATE_KEY"] && output.worker_secret_references["EHR_VAPID_PRIVATE_KEY"] == "staging/app/vapid_private_key"
    error_message = "the VAPID private key is injected by secret name, to the worker only"
  }

  assert {
    condition     = length(output.api_secret_references) == 0
    error_message = "the api gets no injected secret"
  }
}

run "no_emulator_settings_or_static_keys" {
  command = plan

  assert {
    condition = alltrue([for k in [
      "EHR_AWS_ENDPOINT_URL", "EHR_AWS_S3_FORCE_PATH_STYLE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
      "EHR_VAPID_PRIVATE_KEY", "EHR_PATIENT_OIDC_CLIENT_SECRET",
    ] : !contains(keys(output.api_environment), k) && !contains(keys(output.worker_environment), k)])
    error_message = "emulator settings, static credentials and secret values must not be plain environment"
  }
}

run "sms_group_is_all_or_nothing" {
  command = plan
  variables {
    sms_origination_identity_arn = null
  }

  assert {
    condition     = !contains(keys(output.worker_environment), "EHR_SMS_ORIGINATION_IDENTITY") && !contains(keys(output.worker_environment), "EHR_SMS_CONFIGURATION_SET")
    error_message = "without an origination identity neither SMS variable is set (the application keeps refusing SMS)"
  }
}

run "role_arns_are_the_fixed_names" {
  command = plan

  assert {
    condition     = output.api_task_role_arn == "arn:aws:iam::111111111111:role/staging-ehr-api-task" && output.worker_task_role_arn == "arn:aws:iam::111111111111:role/staging-ehr-worker-task" && output.execution_role_arn == "arn:aws:iam::111111111111:role/staging-ehr-task-execution"
    error_message = "role ARNs follow the fixed names"
  }
}

run "buckets_are_kms_encrypted_private_and_versioned" {
  command = plan

  assert {
    condition     = alltrue([for k, v in aws_s3_bucket_server_side_encryption_configuration.this : one(v.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" && one(v.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == var.data_kms_key_arn])
    error_message = "SSE-KMS with the data key"
  }
  assert {
    condition     = alltrue([for k, v in aws_s3_bucket_public_access_block.this : v.block_public_acls && v.block_public_policy && v.ignore_public_acls && v.restrict_public_buckets])
    error_message = "public access blocked"
  }
  assert {
    condition     = alltrue([for k, v in aws_s3_bucket_versioning.this : v.versioning_configuration[0].status == "Enabled"])
    error_message = "versioned"
  }
  assert {
    condition     = aws_s3_bucket.this["packages"].bucket == "ehr-staging-privacy-packages" && aws_s3_bucket.this["exports"].bucket == "ehr-staging-audit-exports"
    error_message = "bucket names"
  }
}

run "payload_key_rotates" {
  command = plan

  assert {
    condition     = aws_kms_key.payload.enable_key_rotation && aws_kms_key.payload.key_usage == "ENCRYPT_DECRYPT"
    error_message = "rotation on"
  }
}

run "guardduty_protects_quarantine_with_tagging" {
  command = plan

  assert {
    condition     = one(one(aws_guardduty_malware_protection_plan.quarantine.protected_resource).s3_bucket).bucket_name == "ehr-staging-docs-quarantine" && one(one(aws_guardduty_malware_protection_plan.quarantine.actions).tagging).status == "ENABLED"
    error_message = "GuardDuty Malware Protection on the quarantine bucket with tagging on"
  }
}

run "ses_requires_tls_and_dkim" {
  command = plan

  assert {
    condition     = one(aws_sesv2_configuration_set.this.delivery_options).tls_policy == "REQUIRE" && one(aws_sesv2_email_identity.domain.dkim_signing_attributes).next_signing_key_length == "RSA_2048_BIT"
    error_message = "TLS required, 2048-bit DKIM"
  }
}

run "video_failure_alarm_watches_the_api_log_group" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_metric_filter.video_vendor_failure.log_group_name == "/ecs/ehr-staging/api" && length(regexall("vendor_call.*video.*!= \"ok\"", aws_cloudwatch_log_metric_filter.video_vendor_failure.pattern)) == 1
    error_message = "metric filter on failed video vendor_call lines in the api log group"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.video_vendor_failure.alarm_actions) == 1 && aws_cloudwatch_metric_alarm.video_vendor_failure.period == 300
    error_message = "5-minute alarm with an action"
  }
}

run "close_meeting_dead_alarm_watches_the_worker_log_group" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_metric_filter.close_meeting_dead.log_group_name == "/ecs/ehr-staging/worker" && length(regexall("job_dead.*telehealth\\.close_meeting", aws_cloudwatch_log_metric_filter.close_meeting_dead.pattern)) == 1
    error_message = "metric filter on job_dead lines of telehealth.close_meeting in the worker log group"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.close_meeting_dead.alarm_actions) == 1 && aws_cloudwatch_metric_alarm.close_meeting_dead.threshold == 1
    error_message = "one dead job raises the alarm, with an action"
  }
}

run "privacy_packages_expire_after_seven_days" {
  command = plan
  assert {
    condition     = one([for k, v in aws_s3_bucket_lifecycle_configuration.this : v if k == "packages"]).rule[0].expiration[0].days == 7
    error_message = "privacy export packages expire after 7 days (ruling C item 2)"
  }
}

run "receipts_are_off_unless_an_endpoint_is_given" {
  command = plan

  assert {
    condition     = length(output.receipt_topic_arns) == 0 && !contains(keys(output.api_environment), "EHR_SNS_RECEIPT_TOPICS")
    error_message = "no SNS topic, event destination or api receipt variable without receipt_endpoint_url"
  }
}

run "receipts_wire_the_ses_event_destination_and_both_topics_to_https_subscriptions" {
  command = plan
  variables {
    receipt_endpoint_url = "https://integrations.example.org/webhooks/sns/receipts"
  }

  assert {
    condition     = length(aws_sns_topic.receipts) == 2 && contains(keys(aws_sns_topic.receipts), "email") && contains(keys(aws_sns_topic.receipts), "sms")
    error_message = "one topic for SES and one for SMS events"
  }

  assert {
    condition = alltrue([for s in values(aws_sns_topic_subscription.receipts) :
      s.protocol == "https" && s.endpoint == "https://integrations.example.org/webhooks/sns/receipts" && s.raw_message_delivery == false && s.endpoint_auto_confirms == false
    ])
    error_message = "HTTPS subscription to the receipt route, signed envelope kept, confirmed by the API"
  }

  assert {
    condition = (
      aws_sesv2_configuration_set_event_destination.receipts[0].event_destination[0].enabled &&
      alltrue([for t in ["DELIVERY", "BOUNCE", "COMPLAINT"] : contains(aws_sesv2_configuration_set_event_destination.receipts[0].event_destination[0].matching_event_types, t)]) &&
      length(aws_sesv2_configuration_set_event_destination.receipts[0].event_destination[0].matching_event_types) == 3
    )
    error_message = "SES event destination carries delivery, bounce and complaint"
  }

  assert {
    condition     = alltrue([for t in values(aws_sns_topic.receipts) : t.kms_master_key_id != null])
    error_message = "receipt topics are encrypted"
  }

  assert {
    condition     = can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+=email,", output.api_environment["EHR_SNS_RECEIPT_TOPICS"])) || can(regex("=sms$", output.api_environment["EHR_SNS_RECEIPT_TOPICS"])) || can(regex("=email", output.api_environment["EHR_SNS_RECEIPT_TOPICS"]))
    error_message = "the api gets the topic ARN -> channel list"
  }

  assert {
    condition     = !contains(keys(output.worker_environment), "EHR_SNS_RECEIPT_TOPICS")
    error_message = "the worker does not receive the route configuration"
  }
}

run "sms_receipts_follow_the_sms_group" {
  command = plan
  variables {
    receipt_endpoint_url         = "https://integrations.example.org/webhooks/sns/receipts"
    sms_origination_identity_arn = null
  }

  assert {
    condition     = length(aws_sns_topic.receipts) == 1 && contains(keys(aws_sns_topic.receipts), "email")
    error_message = "no SMS topic when SMS is not configured"
  }
}

run "receipt_endpoint_must_be_the_receipt_route" {
  command = plan
  variables {
    receipt_endpoint_url = "http://integrations.example.org/webhooks/sns/receipts"
  }
  expect_failures = [var.receipt_endpoint_url]
}
