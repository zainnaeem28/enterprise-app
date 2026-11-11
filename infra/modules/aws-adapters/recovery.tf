# Recovery-Region role policies (R1-GAP-4). Authored, not applied. IAM roles are global, so the primary roles are the
# recovery roles: the payload key replica carries the same key policy, which names these role ARNs. What changes for a
# failover is (1) the trust policy admits ECS tasks of the recovery Region and (2) an extra inline policy names the
# recovery-Region replicas. No cluster, service, task definition or any other compute is made here or in the recovery
# Region (DEVOPS-PLAN 3.2); the recovery runbook creates it during a declared failover.
#
# What the recovery Region gets (HEAAA-850; owner ruling C, best-practice default applied in full):
#   - document upload: a Region-bound quarantine bucket (empty; an upload in flight at failover is retried by the user) and write
#     access to the clean replica bucket for scan promotion;
#   - malware scanning: a GuardDuty Malware Protection plan on that quarantine bucket;
#   - package / export: Region-bound buckets (packages live 7 days and are regenerated; exports are copies of the audit archive);
#   - runtime integration secrets: create / read of ${env}/integration/* in the recovery Region under the recovery secrets key
#     (runtime secrets are created with a replica and promoted at failover, HEAAA-860; see the recovery runbook);
#   - SES: the domain identity and configuration set in the recovery Region; SMS: the configuration set, and sending when
#     recovery_sms_origination_identity_arn is given.
# The one service that does not run in the recovery Region in R1 is the Object Lock anchor archive (its bucket and key are in
# the log-archive account and bound to the primary Region). Its degraded mode is in docs/runbooks/recovery-region.md and the
# decision-log of HEAAA-850.

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

  # Region-bound buckets of the recovery Region. S3 names are global, so each is the primary name plus -dr.
  rr_bucket_names = {
    quarantine = "${var.docs_quarantine_bucket_name}-dr"
    packages   = "${local.package_bucket_name}-dr"
    exports    = "${local.export_bucket_name}-dr"
  }
  rr_bucket_expiry_days = {
    quarantine = var.recovery_quarantine_expiry_days
    packages   = var.package_expiry_days
    exports    = var.export_expiry_days
  }
  rr_quarantine_arn = "arn:${local.partition}:s3:::${local.rr_bucket_names["quarantine"]}"
  rr_packages_arn   = "arn:${local.partition}:s3:::${local.rr_bucket_names["packages"]}"
  rr_exports_arn    = "arn:${local.partition}:s3:::${local.rr_bucket_names["exports"]}"

  rr_secret_integration = "${local.rr_secret_arn_stem}:${var.env}/integration"
  rr_ses_identity_arn   = "arn:${local.partition}:ses:${local.rr}:${local.account_id}:identity/${var.ses_domain}"
  rr_ses_config_arn     = "arn:${local.partition}:ses:${local.rr}:${local.account_id}:configuration-set/${var.env}-ehr-mail"
  rr_sms_config_arn     = "arn:${local.partition}:sms-voice:${local.rr}:${local.account_id}:configuration-set/${var.env}-ehr-sms"
  rr_sms_enabled        = local.recovery_enabled && var.recovery_sms_origination_identity_arn != null
  rr_guardduty_rule_arn = "arn:${local.partition}:events:${local.rr}:${local.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
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
    sid       = "PresignDocumentUploadToRecoveryQuarantine"
    actions   = ["s3:PutObject"]
    resources = ["${local.rr_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "PresignPackageDownloadFromRecovery"
    actions   = ["s3:GetObject"]
    resources = ["${local.rr_packages_arn}/p/*"]
  }

  statement {
    sid       = "WriteOutboundSecretsInRecovery"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
    resources = ["${local.rr_secret_integration}/outbound/*"]
  }

  statement {
    sid       = "ReadInboundVerificationKeysInRecovery"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.rr_secret_integration}/inbound/*"]
  }

  statement {
    sid       = "SecretsKeyRecoveryThroughSecretsManager"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [local.rr_secrets_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_secrets_via
    }
  }

  statement {
    sid       = "DataKeyReplicaForSignedRequests"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
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

  # Scan promotion writes into the replica bucket during a failover (replication into it is a one-way copy from the primary,
  # so objects promoted here are copied back at failback, docs/runbooks/recovery-region.md).
  statement {
    sid       = "CleanReplicaPromotion"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.rr_docs_bucket}/*"]
  }

  statement {
    sid       = "QuarantineList"
    actions   = ["s3:ListBucket"]
    resources = [local.rr_quarantine_arn]
  }

  statement {
    sid       = "QuarantineObjects"
    actions   = ["s3:GetObject", "s3:GetObjectTagging", "s3:DeleteObject"]
    resources = ["${local.rr_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "PackageObjectsInRecovery"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.rr_packages_arn}/p/*"]
  }

  statement {
    sid       = "ExportObjectsInRecovery"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${local.rr_exports_arn}/audit-exports/*"]
  }

  statement {
    sid       = "ExportListInRecovery"
    actions   = ["s3:ListBucket"]
    resources = [local.rr_exports_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["audit-exports/*"]
    }
  }

  statement {
    sid       = "ReadIntegrationSecretsInRecovery"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.rr_secret_integration}/*"]
  }

  statement {
    sid       = "WriteInboundSecretsInRecovery"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
    resources = ["${local.rr_secret_integration}/inbound/*"]
  }

  statement {
    sid       = "SecretsKeyRecoveryThroughSecretsManager"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [local.rr_secrets_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_secrets_via
    }
  }

  statement {
    sid       = "SendMailFromRecoveryRegion"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [local.rr_ses_identity_arn, local.rr_ses_config_arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_from_address]
    }
  }

  statement {
    sid       = "AccountLevelReadsInRecoveryRegion"
    actions   = ["ses:GetAccount", "sms-voice:DescribeAccountAttributes"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.rr]
    }
  }

  dynamic "statement" {
    for_each = local.rr_sms_enabled ? [1] : []
    content {
      sid       = "SendSmsFromRecoveryRegion"
      actions   = ["sms-voice:SendTextMessage"]
      resources = [var.recovery_sms_origination_identity_arn, local.rr_sms_config_arn]
    }
  }

  statement {
    sid       = "DataKeyReplicaDecrypt"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
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

# ---------------------------------------------------------------------------
# Region-bound buckets of the recovery Region: quarantine (uploads), privacy packages, audit exports. They start empty: a
# package is a 7-day regenerable download, an export is a copy of the audit archive, and quarantine holds uploads that the
# user retries. No access logging: S3 server access logs must land in a bucket of the same Region, and the log-archive
# bucket is in the primary Region; object activity is covered by CloudTrail data events.
# ---------------------------------------------------------------------------

#trivy:ignore:AWS-0089 server access logging needs a same-Region log bucket; CloudTrail data events cover the recovery buckets
resource "aws_s3_bucket" "recovery" {
  for_each      = local.recovery_enabled ? local.rr_bucket_names : {}
  provider      = aws.recovery
  bucket        = each.value
  force_destroy = var.force_destroy
  tags          = merge(local.tags, { Name = each.value, DataClass = "recovery-${each.key}" })
}

resource "aws_s3_bucket_versioning" "recovery" {
  for_each = local.recovery_enabled ? local.rr_bucket_names : {}
  provider = aws.recovery
  bucket   = aws_s3_bucket.recovery[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recovery" {
  for_each = local.recovery_enabled ? local.rr_bucket_names : {}
  provider = aws.recovery
  bucket   = aws_s3_bucket.recovery[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = local.rr_data_key
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "recovery" {
  for_each                = local.recovery_enabled ? local.rr_bucket_names : {}
  provider                = aws.recovery
  bucket                  = aws_s3_bucket.recovery[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "recovery" {
  for_each = local.recovery_enabled ? local.rr_bucket_names : {}
  provider = aws.recovery
  bucket   = aws_s3_bucket.recovery[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# The scan pipeline reacts to uploads through EventBridge, as in the primary quarantine bucket.
resource "aws_s3_bucket_notification" "recovery_quarantine" {
  count       = local.recovery_enabled ? 1 : 0
  provider    = aws.recovery
  bucket      = aws_s3_bucket.recovery["quarantine"].id
  eventbridge = true
}

resource "aws_s3_bucket_lifecycle_configuration" "recovery" {
  for_each = local.recovery_enabled ? local.rr_bucket_names : {}
  provider = aws.recovery
  bucket   = aws_s3_bucket.recovery[each.key].id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = local.rr_bucket_expiry_days[each.key]
    }
    noncurrent_version_expiration {
      noncurrent_days = each.key == "quarantine" ? 1 : 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = each.key == "quarantine" ? 1 : 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.recovery]
}

data "aws_iam_policy_document" "recovery_bucket" {
  for_each = local.recovery_enabled ? local.rr_bucket_names : {}

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:${local.partition}:s3:::${each.value}", "arn:${local.partition}:s3:::${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyWritesNotEncryptedWithKms"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["arn:${local.partition}:s3:::${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyWritesWithAnotherKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["arn:${local.partition}:s3:::${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [local.rr_data_key]
    }
  }

  # Packages and exports: only the worker writes or deletes. Quarantine is written through the api's presigned URLs.
  dynamic "statement" {
    for_each = each.key == "quarantine" ? [] : [1]
    content {
      sid       = "OnlyWorkerWritesOrDeletes"
      effect    = "Deny"
      actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = ["arn:${local.partition}:s3:::${each.value}/*"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = ["${local.role_arn_prefix}/${local.worker_role_name}"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "recovery" {
  for_each   = local.recovery_enabled ? local.rr_bucket_names : {}
  provider   = aws.recovery
  bucket     = aws_s3_bucket.recovery[each.key].id
  policy     = data.aws_iam_policy_document.recovery_bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.recovery]
}

# ---------------------------------------------------------------------------
# Malware scanning in the recovery Region: GuardDuty Malware Protection for S3 on the recovery quarantine bucket. The role
# is the primary scan role (IAM is global); a second policy names the recovery bucket, the recovery managed rule and the
# recovery data key. GuardDuty is enabled per Region by the plan itself; the scan-status tag contract is the same.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "recovery_guardduty" {
  count = local.recovery_enabled ? 1 : 0

  statement {
    sid    = "ManagedEventBridgeRule"
    effect = "Allow"
    actions = [
      "events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets",
      "events:DescribeRule", "events:ListTargetsByRule",
    ]
    resources = [local.rr_guardduty_rule_arn]
    condition {
      test     = "StringLike"
      variable = "events:ManagedBy"
      values   = ["malware-protection-plan.guardduty.amazonaws.com"]
    }
  }

  statement {
    sid       = "BucketNotificationsAndLocation"
    effect    = "Allow"
    actions   = ["s3:PutBucketNotification", "s3:GetBucketNotification", "s3:PutBucketOwnershipControls", "s3:GetBucketLocation", "s3:ListBucket"]
    resources = [local.rr_quarantine_arn]
  }

  statement {
    sid       = "ReadAndTagScannedObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging", "s3:GetObjectVersionTagging", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
    resources = ["${local.rr_quarantine_arn}/q/*"]
  }

  statement {
    sid       = "ObjectKeyReplica"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [local.rr_data_key]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.rr_s3_via
    }
  }
}

resource "aws_iam_role_policy" "recovery_guardduty" {
  count      = local.recovery_enabled ? 1 : 0
  name       = "malware-protection-quarantine-recovery"
  role       = aws_iam_role.guardduty.id
  policy     = data.aws_iam_policy_document.recovery_guardduty[0].json
  depends_on = [terraform_data.recovery_inputs]
}

resource "aws_guardduty_malware_protection_plan" "recovery_quarantine" {
  count    = local.recovery_enabled ? 1 : 0
  provider = aws.recovery
  role     = aws_iam_role.guardduty.arn

  protected_resource {
    s3_bucket {
      bucket_name     = aws_s3_bucket.recovery["quarantine"].id
      object_prefixes = ["q/"]
    }
  }

  actions {
    tagging {
      status = "ENABLED"
    }
  }

  tags = local.tags

  depends_on = [aws_iam_role_policy.recovery_guardduty]
}

# ---------------------------------------------------------------------------
# E-mail and SMS in the recovery Region. SES identities and configuration sets are per Region, so the same domain is
# verified again (its own DKIM tokens: three more CNAMEs at go-live, output recovery_ses_dkim_tokens) and the SES
# production-access request is made for the recovery Region too. Cognito's own mail and SMS stay with the identity module.
# ---------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "recovery" {
  count                  = local.recovery_enabled ? 1 : 0
  provider               = aws.recovery
  configuration_set_name = "${var.env}-ehr-mail"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = local.tags
}

resource "aws_sesv2_email_identity" "recovery" {
  count                  = local.recovery_enabled ? 1 : 0
  provider               = aws.recovery
  email_identity         = var.ses_domain
  configuration_set_name = aws_sesv2_configuration_set.recovery[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = local.tags
}

resource "aws_pinpointsmsvoicev2_configuration_set" "recovery" {
  count    = local.recovery_enabled ? 1 : 0
  provider = aws.recovery
  name     = "${var.env}-ehr-sms"
  tags     = local.tags
}
