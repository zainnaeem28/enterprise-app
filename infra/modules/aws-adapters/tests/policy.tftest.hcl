# Evaluates the real IAM policy documents (no mock for aws_iam_policy_document): the assertions read the rendered
# JSON. The provider is configured with throwaway values and no network calls; only the three identity data
# sources are overridden. Plan only.
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "not-a-key"
  secret_key                  = "not-a-secret"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "111111111111" }
}

override_data {
  target = data.aws_region.current
  values = { name = "us-east-2" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

override_resource {
  target = aws_iam_role.api
  values = { arn = "arn:aws:iam::111111111111:role/staging-ehr-api-task", id = "staging-ehr-api-task" }
}

override_resource {
  target = aws_iam_role.worker
  values = { arn = "arn:aws:iam::111111111111:role/staging-ehr-worker-task", id = "staging-ehr-worker-task" }
}

override_resource {
  target = aws_iam_role.execution
  values = { arn = "arn:aws:iam::111111111111:role/staging-ehr-task-execution", id = "staging-ehr-task-execution" }
}

override_resource {
  target = aws_iam_role.guardduty
  values = { arn = "arn:aws:iam::111111111111:role/staging-ehr-guardduty-s3-scan", id = "staging-ehr-guardduty-s3-scan" }
}

override_resource {
  target = aws_iam_role_policy.api
  values = {}
}

override_resource {
  target = aws_iam_role_policy.worker
  values = {}
}

override_resource {
  target = aws_iam_role_policy.execution
  values = {}
}

override_resource {
  target = aws_iam_role_policy.guardduty
  values = {}
}

override_resource {
  target = aws_kms_key.payload
  values = { arn = "arn:aws:kms:us-east-2:111111111111:key/payload", key_id = "payload" }
}

override_resource {
  target = aws_kms_alias.payload
  values = {}
}

override_resource {
  target = aws_s3_bucket.this
  values = { arn = "arn:aws:s3:::mock", id = "mock" }
}

override_resource {
  target = aws_s3_bucket_versioning.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_server_side_encryption_configuration.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_public_access_block.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_ownership_controls.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_logging.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_lifecycle_configuration.this
  values = {}
}

override_resource {
  target = aws_s3_bucket_policy.this
  values = {}
}

override_resource {
  target = aws_sesv2_email_identity.domain
  values = { arn = "arn:aws:ses:us-east-2:111111111111:identity/example.org", dkim_signing_attributes = { tokens = ["a", "b", "c"] } }
}

override_resource {
  target = aws_sesv2_configuration_set.this
  values = {}
}

override_resource {
  target = aws_pinpointsmsvoicev2_configuration_set.this
  values = { arn = "arn:aws:sms-voice:us-east-2:111111111111:configuration-set/staging-ehr-sms" }
}

override_resource {
  target = aws_guardduty_malware_protection_plan.quarantine
  values = { arn = "arn:aws:guardduty:us-east-2:111111111111:malware-protection-plan/x" }
}

override_resource {
  target = aws_cloudwatch_log_metric_filter.video_vendor_failure
  values = {}
}

override_resource {
  target = aws_cloudwatch_metric_alarm.video_vendor_failure
  values = {}
}

override_resource {
  target = aws_cloudwatch_log_metric_filter.close_meeting_dead
  values = {}
}

override_resource {
  target = aws_cloudwatch_metric_alarm.close_meeting_dead
  values = {}
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

run "api_policy_is_exact" {
  command = apply

  # No statement of the api policy grants any of these.
  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      length(setintersection(toset(flatten([s.Action])), toset([
        "kms:Decrypt", "kms:ReEncrypt*", "ses:SendEmail", "ses:SendRawEmail", "chime:CreateMeeting", "chime:DeleteMeeting",
        "s3:DeleteObject", "s3:DeleteObjectVersion", "textract:DetectDocumentText", "sms-voice:SendTextMessage",
      ]))) == 0 || (s.Sid == "DataKeyForSignedRequests" || s.Sid == "SecretsKeyThroughSecretsManager")
    ])
    error_message = "api policy grants an action reserved for the worker (kms:Decrypt is only allowed through S3 / Secrets Manager)"
  }

  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      !contains(flatten([s.Resource]), "*")
    ])
    error_message = "api policy has a wildcard resource"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      s.Sid == "SealPayloadsOnly" && flatten([s.Action]) == ["kms:GenerateDataKey"] && flatten([s.Resource]) == [aws_kms_key.payload.arn]
    ])
    error_message = "the api seals on the payload key with GenerateDataKey only"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      s.Sid == "CreateAttendeeOnly" && flatten([s.Action]) == ["chime:CreateAttendee"]
    ])
    error_message = "the api only creates attendees (DL-1 C4)"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      s.Sid == "WriteOutboundSecrets" && flatten([s.Resource]) == ["arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/integration/outbound/*"]
      ]) && !anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      contains(flatten([s.Action]), "secretsmanager:PutSecretValue") && length(regexall("inbound", join(",", flatten([s.Resource])))) > 0
    ])
    error_message = "the api writes outbound secrets and never inbound ones (SC-3)"
  }
}

run "worker_policy_is_exact" {
  command = apply

  assert {
    condition = !anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      length(setintersection(toset(flatten([s.Action])), toset([
        "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutObjectRetention", "s3:PutObjectLegalHold",
        "s3:PutBucketObjectLockConfiguration", "kms:Encrypt", "kms:ReEncrypt*", "chime:CreateAttendee", "secretsmanager:DeleteSecret",
      ]))) > 0
    ])
    error_message = "worker policy grants a forbidden action"
  }

  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      !contains(flatten([s.Resource]), "*") || contains([
        "AccountLevelReads", "OcrDetectText", "CreateMeeting",
      ], s.Sid)
    ])
    error_message = "a wildcard resource outside the three justified statements"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      s.Sid == "AnchorArchiveObjects" && join(",", sort(flatten([s.Action]))) == "s3:GetObject,s3:GetObjectVersion,s3:PutObject" && flatten([s.Resource]) == ["arn:aws:s3:::ehr-logarchive-audit-archive/anchors/*"]
    ])
    error_message = "anchors: put, get, get version under anchors/ only"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      s.Sid == "OpenPayloadsOnly" && flatten([s.Action]) == ["kms:Decrypt"]
      ]) && !anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      contains(flatten([s.Action]), "kms:GenerateDataKey") && contains(flatten([s.Resource]), aws_kms_key.payload.arn)
    ])
    error_message = "the worker opens payloads and never seals (SC-2)"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      s.Sid == "WriteInboundSecrets" && flatten([s.Resource]) == ["arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/integration/inbound/*"]
    ])
    error_message = "the worker writes inbound secrets only"
  }
}

run "execution_role_reads_only_named_secrets" {
  command = apply

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.execution.json).Statement :
      s.Sid == "InjectNamedSecrets" && flatten([s.Resource]) == ["arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/app/vapid_private_key-??????"]
    ])
    error_message = "execution role reads exactly the named secrets"
  }
}

run "payload_key_policy_separates_seal_and_open" {
  command = apply

  assert {
    condition     = anytrue([for s in jsondecode(data.aws_iam_policy_document.payload_key.json).Statement : s.Sid == "ApiCannotOpen" && s.Effect == "Deny"]) && anytrue([for s in jsondecode(data.aws_iam_policy_document.payload_key.json).Statement : s.Sid == "WorkerCannotSeal" && s.Effect == "Deny"])
    error_message = "the key policy denies api Decrypt and worker GenerateDataKey"
  }
}

run "buckets_refuse_foreign_writers_and_plain_http" {
  command = apply

  assert {
    condition     = alltrue([for k, d in data.aws_iam_policy_document.bucket : anytrue([for s in jsondecode(d.json).Statement : s.Sid == "OnlyWorkerWritesOrDeletes"]) && anytrue([for s in jsondecode(d.json).Statement : s.Sid == "DenyInsecureTransport"])])
    error_message = "package and export buckets: TLS only, worker-only writes"
  }
}

run "guardduty_role_is_scoped_to_the_quarantine_bucket" {
  command = apply

  assert {
    condition = alltrue([for s in jsondecode(data.aws_iam_policy_document.guardduty.json).Statement :
      !contains(flatten([s.Resource]), "*") && alltrue([for r in flatten([s.Resource]) : length(regexall("quarantine|key/data|DO-NOT-DELETE", r)) > 0])
    ])
    error_message = "GuardDuty role policy names only the quarantine bucket, the data key and the managed rule"
  }
}
