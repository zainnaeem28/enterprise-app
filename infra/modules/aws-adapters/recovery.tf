# Recovery-Region role policies (R1-GAP-4). Authored, not applied. IAM roles are global, so the primary roles are the
# recovery roles: the payload key replica carries the same key policy, which names these role ARNs. What changes for a
# failover is (1) the trust policy admits ECS tasks of the recovery Region and (2) an extra inline policy names the
# recovery-Region replicas. No cluster, service, task definition or any other compute is made here or in the recovery
# Region (DEVOPS-PLAN 3.2); the recovery runbook creates it during a declared failover.
#
# Deliberately NOT granted in the recovery Region (nothing there exists to grant against, or it is not verified):
# document upload (the quarantine bucket has no replica), package/export buckets (no replica), runtime-created
# integration secrets (the app makes them; they are not replicated), SES/SMS sending (identities are per Region),
# the Object Lock anchor archive (its key policy and ViaService are bound to the primary Region), GuardDuty scanning.

locals {
  recovery_enabled = var.recovery_region != null

  rr                 = coalesce(var.recovery_region, local.region)
  rr_payload_key_arn = "arn:${local.partition}:kms:${local.rr}:${local.account_id}:key/${aws_kms_key.payload.key_id}"
  # Placeholders keep the policy documents evaluable when an input is missing; the precondition below then fails the plan.
  rr_docs_bucket      = coalesce(var.recovery_docs_clean_bucket_arn, "unset")
  rr_data_key         = coalesce(var.recovery_data_kms_key_arn, "unset")
  rr_secrets_key      = coalesce(var.recovery_secrets_kms_key_arn, "unset")
  rr_s3_via           = ["s3.${local.rr}.amazonaws.com"]
  rr_secrets_via      = ["secretsmanager.${local.rr}.amazonaws.com"]
  rr_secret_arn_stem  = "arn:${local.partition}:secretsmanager:${local.rr}:${local.account_id}:secret"
  rr_ecr_repositories = [for a in var.ecr_repository_arns : replace(a, ":${local.region}:", ":${local.rr}:")]
}

resource "terraform_data" "recovery_inputs" {
  count = local.recovery_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.payload_key_multi_region
      error_message = "recovery_region needs payload_key_multi_region = true: the sealed payloads must open in the recovery Region."
    }
    precondition {
      condition     = var.recovery_region != local.region
      error_message = "recovery_region must differ from the primary Region."
    }
    precondition {
      condition     = var.recovery_data_kms_key_arn != null && var.recovery_secrets_kms_key_arn != null && var.recovery_docs_clean_bucket_arn != null
      error_message = "recovery_region needs recovery_data_kms_key_arn, recovery_secrets_kms_key_arn and recovery_docs_clean_bucket_arn."
    }
  }
}

# Trust for recovery-Region ECS tasks. Same account condition; the source ARN is limited to ECS of the recovery Region.
data "aws_iam_policy_document" "ecs_tasks_assume_with_recovery" {
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
      values = [
        "arn:${local.partition}:ecs:${local.region}:${local.account_id}:*",
        "arn:${local.partition}:ecs:${local.rr}:${local.account_id}:*",
      ]
    }
  }
}

# ---- api: read documents from the replica, seal with the key replica ----

data "aws_iam_policy_document" "recovery_api" {
  count = local.recovery_enabled ? 1 : 0

  statement {
    sid       = "PresignDocumentDownloadFromReplica"
    actions   = ["s3:GetObject"]
    resources = ["${local.rr_docs_bucket}/*"]
  }

  statement {
    sid       = "DataKeyReplicaForSignedRequests"
    actions   = ["kms:Decrypt"]
    resources = [local.rr_data_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_s3_via
    }
  }

  statement {
    sid       = "SealPayloadsOnlyWithReplica"
    actions   = ["kms:GenerateDataKey"]
    resources = [local.rr_payload_key_arn]
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
}

# ---- worker: read the replica, open payloads, end meetings ----

data "aws_iam_policy_document" "recovery_worker" {
  count = local.recovery_enabled ? 1 : 0

  statement {
    sid       = "ReplicaList"
    actions   = ["s3:ListBucket"]
    resources = [local.rr_docs_bucket]
  }

  statement {
    sid       = "ReplicaObjectsRead"
    actions   = ["s3:GetObject", "s3:GetObjectTagging"]
    resources = ["${local.rr_docs_bucket}/*"]
  }

  statement {
    sid       = "DataKeyReplicaDecrypt"
    actions   = ["kms:Decrypt"]
    resources = [local.rr_data_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_s3_via
    }
  }

  statement {
    sid       = "OpenPayloadsOnlyWithReplica"
    actions   = ["kms:Decrypt"]
    resources = [local.rr_payload_key_arn]
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
    sid       = "DescribePayloadKeyReplica"
    actions   = ["kms:DescribeKey"]
    resources = [local.rr_payload_key_arn]
  }

  statement {
    sid       = "OcrDetectTextInRecoveryRegion"
    actions   = ["textract:DetectDocumentText"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.rr]
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
}

# ---- execution: pull the replicated image, log, inject the replicated secrets ----

data "aws_iam_policy_document" "recovery_execution" {
  count = local.recovery_enabled ? 1 : 0

  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "PullPinnedImagesFromReplicatedRepositories"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = local.rr_ecr_repositories
  }

  statement {
    sid       = "WriteTaskLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.rr}:${local.account_id}:log-group:/ecs/${var.compute_name}/*:log-stream:*"]
  }

  statement {
    sid       = "InjectNamedSecretReplicas"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for n in var.execution_secret_names : "${local.rr_secret_arn_stem}:${n}-??????"]
  }

  statement {
    sid       = "SecretsKeyReplicaThroughSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [local.rr_secrets_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_secrets_via
    }
  }
}

resource "aws_iam_role_policy" "recovery_api" {
  count      = local.recovery_enabled ? 1 : 0
  name       = "recovery-region"
  role       = aws_iam_role.api.id
  policy     = data.aws_iam_policy_document.recovery_api[0].json
  depends_on = [terraform_data.recovery_inputs]
}

resource "aws_iam_role_policy" "recovery_worker" {
  count      = local.recovery_enabled ? 1 : 0
  name       = "recovery-region"
  role       = aws_iam_role.worker.id
  policy     = data.aws_iam_policy_document.recovery_worker[0].json
  depends_on = [terraform_data.recovery_inputs]
}

resource "aws_iam_role_policy" "recovery_execution" {
  count      = local.recovery_enabled ? 1 : 0
  name       = "recovery-region"
  role       = aws_iam_role.execution.id
  policy     = data.aws_iam_policy_document.recovery_execution[0].json
  depends_on = [terraform_data.recovery_inputs]
}
