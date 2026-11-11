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

provider "aws" {
  alias                       = "recovery"
  region                      = "us-west-2"
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
  target = aws_iam_role_policy.recovery_api
  values = {}
}

override_resource {
  target = aws_iam_role_policy.recovery_worker
  values = {}
}

override_resource {
  target = aws_iam_role_policy.recovery_execution
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

override_resource {
  target = aws_s3_bucket.recovery
  values = { arn = "arn:aws:s3:::mock-dr", id = "mock-dr" }
}

override_resource {
  target = aws_s3_bucket_versioning.recovery
  values = {}
}

override_resource {
  target = aws_s3_bucket_server_side_encryption_configuration.recovery
  values = {}
}

override_resource {
  target = aws_s3_bucket_public_access_block.recovery
  values = {}
}

override_resource {
  target = aws_s3_bucket_ownership_controls.recovery
  values = {}
}

override_resource {
  target = aws_s3_bucket_notification.recovery_quarantine
  values = {}
}

override_resource {
  target = aws_s3_bucket_lifecycle_configuration.recovery
  values = {}
}

override_resource {
  target = aws_s3_bucket_policy.recovery
  values = {}
}

override_resource {
  target = aws_iam_role_policy.recovery_guardduty
  values = {}
}

override_resource {
  target = aws_guardduty_malware_protection_plan.recovery_quarantine
  values = {}
}

override_resource {
  target = aws_sesv2_configuration_set.recovery
  values = {}
}

override_resource {
  target = aws_sesv2_email_identity.recovery
  values = { arn = "arn:aws:ses:us-west-2:111111111111:identity/example.org", dkim_signing_attributes = { tokens = ["d", "e", "f"] } }
}

override_resource {
  target = aws_pinpointsmsvoicev2_configuration_set.recovery
  values = {}
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
      !contains(flatten([s.Resource]), "*") || s.Effect == "Deny"
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
      s.Effect == "Allow" && contains(flatten([s.Action]), "secretsmanager:PutSecretValue") && length(regexall("inbound", join(",", flatten([s.Resource])))) > 0
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
      !contains(flatten([s.Resource]), "*") || s.Effect == "Deny" || contains([
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

# SC-2 (ARCHITECTURE 25.9 item 6, HEAAA-870 D-4a): explicit, tested denies on the secret store and the key policies.
run "app_roles_have_explicit_secret_and_key_policy_denies" {
  command = apply

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      s.Sid == "ApiCannotWriteInboundSecrets" && s.Effect == "Deny" &&
      join(",", sort(flatten([s.Action]))) == "secretsmanager:CreateSecret,secretsmanager:PutSecretValue,secretsmanager:ReplicateSecretToRegions,secretsmanager:UpdateSecret" &&
      flatten([s.Resource]) == ["arn:aws:secretsmanager:*:111111111111:secret:staging/integration/inbound/*"]
    ])
    error_message = "api must explicitly deny writes to inbound secrets in every Region"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      s.Sid == "WorkerCannotWriteOutboundSecrets" && s.Effect == "Deny" &&
      join(",", sort(flatten([s.Action]))) == "secretsmanager:CreateSecret,secretsmanager:PutSecretValue,secretsmanager:ReplicateSecretToRegions,secretsmanager:UpdateSecret" &&
      flatten([s.Resource]) == ["arn:aws:secretsmanager:*:111111111111:secret:staging/integration/outbound/*"]
    ])
    error_message = "worker must explicitly deny writes to outbound secrets in every Region"
  }

  assert {
    condition = alltrue([for doc in [data.aws_iam_policy_document.api.json, data.aws_iam_policy_document.worker.json] :
      anytrue([for s in jsondecode(doc).Statement :
        s.Sid == "CannotChangeSecretPolicyOrReplication" && s.Effect == "Deny" &&
        join(",", sort(flatten([s.Action]))) == "secretsmanager:DeleteResourcePolicy,secretsmanager:PutResourcePolicy,secretsmanager:RemoveRegionsFromReplication,secretsmanager:StopReplicationToReplica" &&
        flatten([s.Resource]) == ["*"]
      ])
    ])
    error_message = "both app roles must deny secret policy and replication changes"
  }

  assert {
    condition = alltrue([for doc in [data.aws_iam_policy_document.api.json, data.aws_iam_policy_document.worker.json] :
      anytrue([for s in jsondecode(doc).Statement :
        s.Sid == "CannotChangeKeyPolicy" && s.Effect == "Deny" && flatten([s.Action]) == ["kms:PutKeyPolicy"] && flatten([s.Resource]) == ["*"]
      ])
    ])
    error_message = "both app roles must deny kms:PutKeyPolicy"
  }

  # No Allow names a denied action on a denied resource (or through a wildcard action).
  assert {
    condition = !anytrue(flatten([
      for doc in [data.aws_iam_policy_document.api.json, data.aws_iam_policy_document.worker.json] : [
        for s in jsondecode(doc).Statement : s.Effect == "Allow" && length(setintersection(toset(flatten([s.Action])), toset([
          "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy", "secretsmanager:RemoveRegionsFromReplication",
          "secretsmanager:StopReplicationToReplica", "kms:PutKeyPolicy", "secretsmanager:*", "kms:*", "*",
        ]))) > 0
      ]
    ]))
    error_message = "an app role allows a secret-policy, replication or key-policy action"
  }

  assert {
    condition = !anytrue([for s in jsondecode(data.aws_iam_policy_document.api.json).Statement :
      s.Effect == "Allow" && length(setintersection(toset(flatten([s.Action])), toset(["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:ReplicateSecretToRegions"]))) > 0 &&
      anytrue([for r in flatten([s.Resource]) : r != "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/integration/outbound/*"])
    ])
    error_message = "a api Allow of secret writes reaches anything but outbound secrets"
  }

  assert {
    condition = !anytrue([for s in jsondecode(data.aws_iam_policy_document.worker.json).Statement :
      s.Effect == "Allow" && length(setintersection(toset(flatten([s.Action])), toset(["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:ReplicateSecretToRegions"]))) > 0 &&
      anytrue([for r in flatten([s.Resource]) : r != "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/integration/inbound/*"])
    ])
    error_message = "a worker Allow of secret writes reaches anything but inbound secrets"
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

run "recovery_policies_name_only_recovery_region_replicas" {
  command = apply

  variables {
    payload_key_multi_region       = true
    recovery_region                = "us-west-2"
    recovery_data_kms_key_arn      = "arn:aws:kms:us-west-2:111111111111:key/mrk-data"
    recovery_secrets_kms_key_arn   = "arn:aws:kms:us-west-2:111111111111:key/secrets-dr"
    recovery_docs_clean_bucket_arn = "arn:aws:s3:::ehr-staging-docs-clean-replica"
  }

  assert {
    condition = alltrue(flatten([for d in [data.aws_iam_policy_document.recovery_api[0], data.aws_iam_policy_document.recovery_worker[0], data.aws_iam_policy_document.recovery_execution[0]] :
      [for s in jsondecode(d.json).Statement : alltrue([for r in flatten([s.Resource]) :
        r == "*" || strcontains(r, "us-west-2") || strcontains(r, "docs-clean-replica") || strcontains(r, "-dr") || strcontains(r, ":chime:")
      ])]
    ]))
    error_message = "every resource of the recovery policies is in the recovery Region, the replica bucket, a recovery-Region bucket (-dr) or a Chime meeting"
  }

  # "*" resources: only the AWS-limited actions, and the Region-bound ones carry aws:RequestedRegion.
  assert {
    condition = alltrue(flatten([for d in [data.aws_iam_policy_document.recovery_api[0], data.aws_iam_policy_document.recovery_worker[0], data.aws_iam_policy_document.recovery_execution[0]] :
      [for s in jsondecode(d.json).Statement : !contains(flatten([s.Resource]), "*") || contains(["EcrToken", "OcrDetectTextInRecoveryRegion", "AccountLevelReadsInRecoveryRegion", "CreateMeeting"], s.Sid)]
    ]))
    error_message = "no wildcard resource beyond ecr:GetAuthorizationToken, textract, the SES/SMS account reads and chime:CreateMeeting"
  }

  # api: seals only (never opens a payload); the only writes are the presigned quarantine upload and its own outbound secrets.
  assert {
    condition = !anytrue(flatten([for s in jsondecode(data.aws_iam_policy_document.recovery_api[0].json).Statement :
      [for a in flatten([s.Action]) : (contains(["kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*"], a) && !contains(["DataKeyReplicaForSignedRequests", "SecretsKeyRecoveryThroughSecretsManager"], s.Sid)) ||
        (contains(["s3:PutObject", "s3:DeleteObject"], a) && s.Sid != "PresignDocumentUploadToRecoveryQuarantine")
      || (contains(["secretsmanager:PutSecretValue", "secretsmanager:CreateSecret"], a) && s.Sid != "WriteOutboundSecretsInRecovery")]
    ]))
    error_message = "recovery api cannot open payloads, delete, or write anything beyond the quarantine upload and outbound secrets"
  }

  # worker: never seals (SC-2) and writes only the recovery buckets, the clean replica and inbound secrets.
  assert {
    condition = !anytrue(flatten([for s in jsondecode(data.aws_iam_policy_document.recovery_worker[0].json).Statement :
      [for a in flatten([s.Action]) : (contains(["kms:GenerateDataKey", "kms:GenerateDataKey*", "kms:Encrypt", "kms:ReEncrypt*"], a) && !contains(["DataKeyReplicaDecrypt", "SecretsKeyRecoveryThroughSecretsManager"], s.Sid)) ||
        (contains(["s3:PutObject", "s3:DeleteObject"], a) && !contains(["CleanReplicaPromotion", "QuarantineObjects", "PackageObjectsInRecovery", "ExportObjectsInRecovery"], s.Sid))
      || (contains(["secretsmanager:PutSecretValue", "secretsmanager:CreateSecret"], a) && s.Sid != "WriteInboundSecretsInRecovery")]
    ]))
    error_message = "recovery worker cannot seal payloads (SC-2); its writes are limited to the recovery buckets, the clean replica and inbound secrets"
  }

  assert {
    condition     = !anytrue(flatten([for s in jsondecode(data.aws_iam_policy_document.recovery_worker[0].json).Statement : [for r in flatten([s.Resource]) : strcontains(r, "anchor")]]))
    error_message = "the anchor archive is a degraded mode in the recovery Region: no grant names it"
  }

  # The new recovery services: everything named has a recovery-Region counterpart, and SMS stays out without an identity.
  assert {
    condition = alltrue([for sid in ["PresignDocumentUploadToRecoveryQuarantine", "PresignPackageDownloadFromRecovery", "WriteOutboundSecretsInRecovery"] :
      anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_api[0].json).Statement : s.Sid == sid])
      ]) && alltrue([for sid in ["QuarantineObjects", "PackageObjectsInRecovery", "ExportObjectsInRecovery", "ReadIntegrationSecretsInRecovery", "SendMailFromRecoveryRegion"] :
      anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_worker[0].json).Statement : s.Sid == sid])
    ])
    error_message = "upload, package, export, runtime secrets and mail are granted in the recovery Region"
  }

  assert {
    condition     = !anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_worker[0].json).Statement : s.Sid == "SendSmsFromRecoveryRegion"])
    error_message = "no SMS grant without recovery_sms_origination_identity_arn (degraded mode)"
  }

  assert {
    condition     = length(aws_s3_bucket.recovery) == 3 && length(aws_guardduty_malware_protection_plan.recovery_quarantine) == 1 && length(aws_sesv2_email_identity.recovery) == 1 && length(aws_pinpointsmsvoicev2_configuration_set.recovery) == 1
    error_message = "three recovery buckets, a malware plan, an SES identity and an SMS configuration set exist in the recovery Region"
  }

  assert {
    condition     = output.recovery_environment.common.EHR_S3_DOCS_QUARANTINE_BUCKET == "ehr-staging-docs-quarantine-dr" && contains(output.recovery_environment.worker_unset, "EHR_S3_ANCHOR_ARCHIVE_BUCKET") && contains(output.recovery_environment.worker_unset, "EHR_SMS_ORIGINATION_IDENTITY")
    error_message = "the recovery environment points at the recovery buckets and unsets the anchor archive and SMS variables"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_execution[0].json).Statement :
      s.Sid == "InjectNamedSecretReplicas" && flatten([s.Resource]) == ["arn:aws:secretsmanager:us-west-2:111111111111:secret:staging/app/vapid_private_key-??????"]
      ]) && anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_execution[0].json).Statement :
      s.Sid == "PullPinnedImagesFromReplicatedRepositories" && flatten([s.Resource]) == ["arn:aws:ecr:us-west-2:111111111111:repository/ehr-api"]
    ])
    error_message = "execution reads exactly the replicated VAPID secret and the replicated repository"
  }

  assert {
    condition     = strcontains(data.aws_iam_policy_document.ecs_tasks_assume_with_recovery.json, "ecs:us-west-2:111111111111") && strcontains(data.aws_iam_policy_document.ecs_tasks_assume_with_recovery.json, "ecs:us-east-2:111111111111")
    error_message = "trust admits ECS tasks of the primary and the recovery Region of this account only"
  }

  # SC-2: no recovery identity allows a denied action on the class the matching app role is denied. The recovery roles
  # legitimately write their own class in the recovery Region (api: outbound, worker: inbound); policy, replication and
  # key-policy changes are never allowed to either.
  assert {
    condition = alltrue([for pair in [
      { doc = data.aws_iam_policy_document.recovery_api[0].json, other = "inbound" },
      { doc = data.aws_iam_policy_document.recovery_worker[0].json, other = "outbound" },
      ] : !anytrue([for s in jsondecode(pair.doc).Statement :
        s.Effect == "Allow" && (
          length(setintersection(toset(flatten([s.Action])), toset([
            "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy", "secretsmanager:RemoveRegionsFromReplication",
            "secretsmanager:StopReplicationToReplica", "kms:PutKeyPolicy",
          ]))) > 0 ||
          (length(setintersection(toset(flatten([s.Action])), toset(["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:ReplicateSecretToRegions"]))) > 0 &&
          anytrue([for r in flatten([s.Resource]) : strcontains(r, "/integration/${pair.other}/") || r == "*" || endswith(r, "/integration/*")]))
        )
    ])])
    error_message = "a recovery role allows a denied secret, replication or key-policy action"
  }
}

run "recovery_sms_is_granted_with_a_recovery_identity" {
  command = apply

  variables {
    payload_key_multi_region              = true
    recovery_region                       = "us-west-2"
    recovery_data_kms_key_arn             = "arn:aws:kms:us-west-2:111111111111:key/mrk-data"
    recovery_secrets_kms_key_arn          = "arn:aws:kms:us-west-2:111111111111:key/secrets-dr"
    recovery_docs_clean_bucket_arn        = "arn:aws:s3:::ehr-staging-docs-clean-replica"
    recovery_sms_origination_identity_arn = "arn:aws:sms-voice:us-west-2:111111111111:phone-number/phone-0001"
  }

  assert {
    condition = anytrue([for s in jsondecode(data.aws_iam_policy_document.recovery_worker[0].json).Statement :
      s.Sid == "SendSmsFromRecoveryRegion" && alltrue([for r in flatten([s.Resource]) : strcontains(r, "us-west-2")])
    ])
    error_message = "SMS is granted on the recovery-Region identity and configuration set only"
  }

  assert {
    condition     = !contains(output.recovery_environment.worker_unset, "EHR_SMS_ORIGINATION_IDENTITY") && output.recovery_environment.worker.EHR_SMS_ORIGINATION_IDENTITY == var.recovery_sms_origination_identity_arn
    error_message = "the recovery environment carries the recovery SMS identity"
  }
}

run "recovery_needs_its_inputs" {
  command = plan

  variables {
    payload_key_multi_region = true
    recovery_region          = "us-west-2"
  }
  expect_failures = [terraform_data.recovery_inputs]
}

run "recovery_refuses_a_single_region_payload_key" {
  command = plan

  variables {
    payload_key_multi_region       = false
    recovery_region                = "us-west-2"
    recovery_data_kms_key_arn      = "arn:aws:kms:us-west-2:111111111111:key/mrk-data"
    recovery_secrets_kms_key_arn   = "arn:aws:kms:us-west-2:111111111111:key/secrets-dr"
    recovery_docs_clean_bucket_arn = "arn:aws:s3:::ehr-staging-docs-clean-replica"
  }
  expect_failures = [terraform_data.recovery_inputs]
}

run "without_recovery_region_nothing_recovery_exists" {
  command = plan

  assert {
    condition     = length(aws_iam_role_policy.recovery_api) + length(aws_iam_role_policy.recovery_worker) + length(aws_iam_role_policy.recovery_execution) + length(terraform_data.recovery_inputs) + length(aws_s3_bucket.recovery) + length(aws_guardduty_malware_protection_plan.recovery_quarantine) + length(aws_sesv2_email_identity.recovery) == 0
    error_message = "no recovery policy without recovery_region"
  }
}
