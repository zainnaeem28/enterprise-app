# Task roles on exact resources. Every statement names its resources; the few "*" resources are AWS limits and
# say why. The api never reads payload plaintext, writes inbound secrets, sends mail or touches meetings other
# than creating an attendee; the worker never seals (AWS-ADAPTERS.md lists the same actions per adapter).

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = local.api_role_name
  description        = "${var.env} api task: presigns uploads/downloads, seals payloads, writes outbound secrets, creates Chime attendees"
  assume_role_policy = local.recovery_enabled ? data.aws_iam_policy_document.ecs_tasks_assume_with_recovery.json : data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "worker" {
  name               = local.worker_role_name
  description        = "${var.env} worker task: scan promotion, OCR, packages, exports, anchors, opens payloads, sends mail/SMS, ends meetings"
  assume_role_policy = local.recovery_enabled ? data.aws_iam_policy_document.ecs_tasks_assume_with_recovery.json : data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "execution" {
  name               = local.execution_role_name
  description        = "${var.env} task execution: pull images, write logs, inject named secrets"
  assume_role_policy = local.recovery_enabled ? data.aws_iam_policy_document.ecs_tasks_assume_with_recovery.json : data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

locals {
  s3_via      = ["s3.${local.region}.amazonaws.com"]
  secrets_via = ["secretsmanager.${local.region}.amazonaws.com"]
  # Replica promotion is an operator action (recovery-region runbook 2.2), never an app-role action.
  secret_write_actions  = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:ReplicateSecretToRegions"]
  secret_policy_actions = ["secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy", "secretsmanager:RemoveRegionsFromReplication", "secretsmanager:StopReplicationToReplica"]
  chime_meetings        = "arn:${local.partition}:chime:${var.chime_media_region}:${local.account_id}:meeting/*"
}

# ---- api ----

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "PresignDocumentUpload"
    actions   = ["s3:PutObject"]
    resources = ["${local.docs_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "PresignDocumentDownload"
    actions   = ["s3:GetObject"]
    resources = ["${local.docs_clean_arn}/*"]
  }

  statement {
    sid       = "PresignPackageDownload"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this["packages"].arn}/p/*"]
  }

  statement {
    sid       = "DataKeyForSignedRequests"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.s3_via
    }
  }

  statement {
    sid       = "WriteOutboundSecrets"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
    resources = ["${local.secret_arn_prefix}/integration/outbound/*"]
  }

  statement {
    sid       = "ReadInboundVerificationKeys"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn_prefix}/integration/inbound/*"]
  }

  statement {
    sid       = "SecretsKeyThroughSecretsManager"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.secrets_via
    }
  }

  statement {
    sid       = "SealPayloadsOnly"
    actions   = ["kms:GenerateDataKey"]
    resources = [aws_kms_key.payload.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["ehr:ctx"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContextKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "CreateAttendeeOnly"
    actions   = ["chime:CreateAttendee"]
    resources = [local.chime_meetings]
  }

  # SC-2: explicit deny, all Regions, so a later grant (HEAAA-860) cannot reach the other class.
  statement {
    sid       = "ApiCannotWriteInboundSecrets"
    effect    = "Deny"
    actions   = local.secret_write_actions
    resources = ["${local.secret_arn_any_region}/integration/inbound/*"]
  }

  statement {
    sid       = "CannotChangeSecretPolicyOrReplication"
    effect    = "Deny"
    actions   = local.secret_policy_actions
    resources = ["*"]
  }

  statement {
    sid       = "CannotChangeKeyPolicy"
    effect    = "Deny"
    actions   = ["kms:PutKeyPolicy"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "aws-adapters"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ---- worker ----

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "DocumentsList"
    actions   = ["s3:ListBucket"]
    resources = [local.docs_quarantine_arn, local.docs_clean_arn]
  }

  statement {
    sid       = "QuarantineObjects"
    actions   = ["s3:GetObject", "s3:GetObjectTagging", "s3:DeleteObject"]
    resources = ["${local.docs_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "CleanObjects"
    actions   = ["s3:GetObject", "s3:GetObjectTagging", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.docs_clean_arn}/*"]
  }

  statement {
    sid       = "PackageObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.this["packages"].arn}/p/*"]
  }

  statement {
    sid       = "ExportObjects"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.this["exports"].arn}/audit-exports/*"]
  }

  statement {
    sid       = "ExportList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this["exports"].arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["audit-exports/*"]
    }
  }

  statement {
    sid       = "DataKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.s3_via
    }
  }

  # Textract reads the object with the caller's permissions, so the Decrypt above also serves OCR.
  # Anchors live in the log-archive account; its bucket policy and key policy admit this role too.
  # No s3:DeleteObjectVersion, no retention or legal-hold actions, no BypassGovernanceRetention.
  statement {
    sid       = "AnchorArchiveObjects"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.anchor_bucket_arn}/anchors/*"]
  }

  statement {
    sid       = "AnchorArchiveList"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [local.anchor_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["anchors/*"]
    }
  }

  statement {
    sid       = "AnchorArchiveKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.anchor_archive_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.s3_via
    }
  }

  statement {
    sid       = "ReadIntegrationSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn_prefix}/integration/*"]
  }

  statement {
    sid       = "WriteInboundSecrets"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
    resources = ["${local.secret_arn_prefix}/integration/inbound/*"]
  }

  statement {
    sid       = "SecretsKeyThroughSecretsManager"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.secrets_via
    }
  }

  statement {
    sid       = "OpenPayloadsOnly"
    actions   = ["kms:Decrypt"]
    resources = concat([aws_kms_key.payload.arn], var.payload_previous_key_arns)
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["ehr:ctx"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContextKeys"
      values   = ["false"]
    }
  }

  # Resolves an alias once at start (only used when a key id is configured as an alias).
  statement {
    sid       = "DescribePayloadKeys"
    actions   = ["kms:DescribeKey"]
    resources = concat([aws_kms_key.payload.arn], var.payload_previous_key_arns)
  }

  statement {
    sid       = "SendMail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [local.ses_identity_arn, local.ses_config_arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_from_address]
    }
  }

  # ses:GetAccount and sms-voice:DescribeAccountAttributes, textract:DetectDocumentText and chime:CreateMeeting
  # have no resource-level permissions in AWS; they are read-only or constrained by the request Region.
  statement {
    sid       = "AccountLevelReads"
    actions   = ["ses:GetAccount", "sms-voice:DescribeAccountAttributes"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = local.sms_enabled ? [1] : []
    content {
      sid       = "SendSms"
      actions   = ["sms-voice:SendTextMessage"]
      resources = [var.sms_origination_identity_arn, local.sms_config_arn]
    }
  }

  statement {
    sid       = "OcrDetectText"
    actions   = ["textract:DetectDocumentText"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  statement {
    sid       = "CreateMeeting"
    actions   = ["chime:CreateMeeting"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.chime_media_region]
    }
  }

  statement {
    sid       = "EndMeetings"
    actions   = ["chime:DeleteMeeting", "chime:GetMeeting"]
    resources = [local.chime_meetings]
  }

  # SC-2: explicit deny, all Regions, so a later grant (HEAAA-860) cannot reach the other class.
  statement {
    sid       = "WorkerCannotWriteOutboundSecrets"
    effect    = "Deny"
    actions   = local.secret_write_actions
    resources = ["${local.secret_arn_any_region}/integration/outbound/*"]
  }

  statement {
    sid       = "CannotChangeSecretPolicyOrReplication"
    effect    = "Deny"
    actions   = local.secret_policy_actions
    resources = ["*"]
  }

  statement {
    sid       = "CannotChangeKeyPolicy"
    effect    = "Deny"
    actions   = ["kms:PutKeyPolicy"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "aws-adapters"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

# ---- task execution ----

data "aws_iam_policy_document" "execution" {
  # ecr:GetAuthorizationToken does not support resource-level permissions (AWS requirement for "*").
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "PullPinnedImages"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = var.ecr_repository_arns
  }

  statement {
    sid       = "WriteTaskLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/ecs/${var.compute_name}/*:log-stream:*"]
  }

  statement {
    sid       = "InjectNamedSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for n in var.execution_secret_names : "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${n}-??????"]
  }

  statement {
    sid       = "SecretsKeyThroughSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.secrets_via
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "task-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}
