# Allow-side statements per role, then the rendered inline policy. Statement shape:
# sid, effect, actions, resources (or not_res), conditions, on (granted by the record).

locals {
  d = { effect = "Allow", resources = null, not_res = null, conditions = {}, on = true }

  ecs_cluster_cond = { ArnEquals = { "ecs:cluster" = coalesce(var.refs.ecs_cluster_arn, "arn:aws:ecs:*:*:cluster/unset") } }
  passed_to_ecs    = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }

  read_only_actions = [
    "ec2:Describe*", "ecs:Describe*", "ecs:List*", "rds:Describe*", "rds:ListTagsForResource",
    "elasticloadbalancing:Describe*", "kms:Describe*", "kms:List*", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus",
    "iam:Get*", "iam:List*", "cognito-idp:Describe*", "cognito-idp:List*", "cognito-idp:GetUserPoolMfaConfig",
    "cognito-idp:GetWebAuthnRelyingParty", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecrets",
    "ssm:DescribeParameters", "logs:Describe*", "logs:ListTagsForResource", "cloudwatch:Describe*", "cloudwatch:ListTagsForResource",
    "s3:GetBucket*", "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:ListAllMyBuckets",
    "route53:Get*", "route53:List*", "cloudfront:Get*", "cloudfront:List*", "sns:Get*", "sns:List*", "ses:Get*", "ses:List*",
    "events:Describe*", "events:List*", "ecr:Describe*", "ecr:List*", "ecr:GetRepositoryPolicy", "ecr:GetLifecyclePolicy",
    "backup:Describe*", "backup:List*", "backup:Get*", "wafv2:Get*", "wafv2:List*", "acm:Describe*", "acm:List*", "sqs:Get*", "sqs:List*",
    "application-autoscaling:Describe*", "tag:GetResources",
  ]

  state_read = [
    { sid = "StateRead", actions = ["s3:GetObject", "s3:GetObjectVersion"], resources = ["${var.state_bucket_arn}/*"] },
    { sid = "StateList", actions = ["s3:ListBucket", "s3:GetBucketVersioning"], resources = [var.state_bucket_arn] },
    { sid = "StateKeyDecrypt", actions = ["kms:Decrypt", "kms:DescribeKey"], resources = [var.state_kms_key_arn] },
  ]
  state_write = [
    { sid = "StateWrite", actions = ["s3:PutObject", "s3:DeleteObject"], resources = ["${var.state_bucket_arn}/*"] },
    { sid = "StateKeyEncrypt", actions = ["kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"], resources = [var.state_kms_key_arn] },
  ]

  # Terraform-apply roles: workload services only, no IAM write, no object data access,
  # no secret values, no key use for data. PassRole to an explicit list.
  tf_actions = [
    "ec2:*", "ecs:*", "elasticloadbalancing:*", "rds:*", "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:Get*", "kms:List*", "kms:Put*",
    "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:TagResource", "kms:UntagResource",
    "kms:ReplicateKey", "cognito-idp:*", "cognito-identity:*", "logs:*", "cloudwatch:*", "events:*", "sns:*", "sqs:*", "ses:*", "acm:*",
    "route53:*", "cloudfront:*", "wafv2:*", "backup:*", "application-autoscaling:*", "ecr:*", "tag:*",
    "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy",
    "secretsmanager:TagResource", "secretsmanager:UntagResource",
    "secretsmanager:UpdateSecret", "secretsmanager:ReplicateSecretToRegions", "secretsmanager:RemoveRegionsFromReplication",
    "ssm:PutParameter", "ssm:GetParameter*", "ssm:DescribeParameters", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource", "ssm:DeleteParameter",
    "s3:CreateBucket", "s3:DeleteBucket", "s3:ListAllMyBuckets", "s3:*Bucket*", "s3:Get*Configuration", "s3:Put*Configuration", "s3:Delete*Configuration",
    "iam:Get*", "iam:List*", "iam:CreateServiceLinkedRole",
  ]

  # Keys whose policy is a control: record, state, release signing, restore and secrets keys.
  protected_key_arns = compact([var.ssm_kms_key_arn, var.state_kms_key_arn, var.refs.signing_key_arn, var.refs.restore_kms_key_arn, var.refs.secrets_kms_key_arn])

  protected_bucket_arns = compact([var.state_bucket_arn, var.refs.release_manifest_bucket_arn, var.refs.audit_bucket_arn])

  tf_statements = concat(local.state_read, local.state_write, [
    { sid = "WorkloadServices", actions = local.tf_actions, resources = ["*"] },
    {
      sid       = "NoBucketObjectDataAccessOutsideState"
      effect    = "Deny"
      actions   = ["s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*"]
      not_res   = ["${var.state_bucket_arn}/*"]
      resources = null
    },
    { sid = "NoFaultSwitchWrites", effect = "Deny", actions = ["ssm:PutParameter", "ssm:DeleteParameter"], resources = ["arn:aws:ssm:*:*:parameter/*/faults/*"] },
    # Data keys are used through S3 (state) or SSM (the /approved/* SecureString records); never directly.
    { sid = "NoKeyUseForData", effect = "Deny", actions = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"], resources = ["*"], not_res = null,
    conditions = { StringNotEquals = { "kms:ViaService" = ["s3.${var.region}.amazonaws.com", "ssm.${var.region}.amazonaws.com"] } } },
    { sid = "StateKeyOnlyViaS3", effect = "Deny", actions = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"], resources = [var.state_kms_key_arn], not_res = null,
    conditions = { StringNotEquals = { "kms:ViaService" = ["s3.${var.region}.amazonaws.com"] } } },
    { sid = "RecordKeyOnlyViaSsm", effect = "Deny", actions = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"], resources = [var.ssm_kms_key_arn], not_res = null,
    conditions = { StringNotEquals = { "kms:ViaService" = ["ssm.${var.region}.amazonaws.com"] } } },
    # The controls that protect the records and the evidence: the key policy of the record key and
    # the state key, and the policy and configuration of the state, manifest and audit buckets.
    { sid = "NoEditOfRecordAndEvidenceKeys", effect = "Deny", actions = ["kms:PutKeyPolicy", "kms:Put*", "kms:Update*", "kms:Disable*", "kms:ScheduleKeyDeletion", "kms:Revoke*", "kms:CreateGrant"], resources = local.protected_key_arns, not_res = null },
    # Secret resource policies pin who may read and write each value; changing them is a human apply
    # through break-glass, never a gh-* role (S2).
    { sid = "NoEditOfSecretResourcePolicies", effect = "Deny", actions = ["secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy"], resources = ["*"], not_res = null },
    { sid = "NoEditOfEvidenceBuckets", effect = "Deny", actions = ["s3:PutBucket*", "s3:DeleteBucket*", "s3:Put*Configuration", "s3:Delete*Configuration", "s3:DeleteBucket"], resources = local.protected_bucket_arns, not_res = null },
  ])

  allow = {
    "gh-ci-plan" = concat(local.state_read, [
      { sid = "ReadOnlyDescribe", actions = local.read_only_actions, resources = ["*"] },
    ])

    "gh-build" = [
      { sid = "EcrLogin", actions = ["ecr:GetAuthorizationToken"], resources = ["*"] },
      {
        sid       = "EcrPushByDigest"
        actions   = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"]
        resources = var.refs.ecr_repository_arns
      },
      { sid = "SignWithReleaseKey", actions = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"], resources = compact([var.refs.signing_key_arn]) },
      { sid = "WriteReleaseManifest", actions = ["s3:PutObject"], resources = [for a in compact([var.refs.release_manifest_bucket_arn]) : "${a}/*"] },
      { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-build"]] },
    ]

    "gh-nightly-staging" = concat(local.state_read, [
      { sid = "ReadOnlyDescribe", actions = local.read_only_actions, resources = ["*"] },
      { sid = "GateCheckReads", actions = ["logs:StartQuery", "logs:GetQueryResults", "logs:FilterLogEvents", "logs:GetLogEvents", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "backup:DescribeRestoreJob", "backup:ListRecoveryPointsByBackupVault"], resources = ["*"] },
    ])

    "gh-deploy-staging"    = concat(lookup(local.deploy_statements, "gh-deploy-staging", []), local.portal_statements)
    "gh-deploy-production" = concat(lookup(local.deploy_statements, "gh-deploy-production", []), local.portal_statements)

    "gh-observe-production" = [
      { sid = "ObserveReadOnly", actions = ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics", "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "ecs:Describe*", "ecs:List*", "elasticloadbalancing:Describe*", "rds:DescribeDBInstances", "logs:DescribeLogGroups"], resources = ["*"] },
      { sid = "ObserveLogs", actions = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartQuery", "logs:GetQueryResults"], resources = var.refs.log_group_arns },
      { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-observe-production"]] },
      { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
    ]

    "gh-recover-production" = [
      { sid = "UpdateNamedServices", actions = ["ecs:UpdateService"], resources = var.refs.service_arns, conditions = local.ecs_cluster_cond },
      { sid = "DescribeForRollbackSmoke", actions = ["ecs:Describe*", "ecs:List*", "elasticloadbalancing:Describe*"], resources = ["*"] },
      { sid = "PassOnlyRolesNamedInTheRecoverRecord", actions = ["iam:PassRole"], resources = var.refs.recover_passrole_arns, conditions = local.passed_to_ecs },
      { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-recover-production"]] },
      { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
      # Portal revert is the same switch with the previous sha (scripts/deploy/portal-switch.mjs).
      { sid = "PortalLivePointerWrite", actions = ["s3:PutObject"], resources = [for a in compact([var.refs.portal_bucket_arn]) : "${a}/live/*"] },
      { sid = "PortalReleaseSourceRead", actions = ["s3:GetObject"], resources = flatten([for a in compact([var.refs.portal_bucket_arn, var.refs.release_store_read_arn]) : ["${a}/releases/*"]]) },
      { sid = "PortalInvalidate", actions = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], resources = var.refs.portal_distribution_arns },
    ]

    "gh-tf-staging"    = concat(local.tf_statements, local.tf_passrole_conditioned, local.record_read["gh-tf-staging"])
    "gh-tf-production" = concat(local.tf_statements, local.tf_passrole_conditioned, local.record_read["gh-tf-production"])

    "gh-rehearsal-staging" = concat(local.tf_statements, [
      { sid = "PassFixedRehearsalRoles", actions = ["iam:PassRole"], resources = var.refs.rehearsal_passrole_arns, conditions = local.passed_to_ecs },
      { sid = "RehearsalRecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-rehearsal-staging"]] },
      { sid = "RehearsalRecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
    ])

    "gh-restore-test" = [
      { sid = "RunPinnedRestoreTaskOnly", actions = ["ecs:RunTask"], resources = compact([var.refs.restore_task_definition_arn]), conditions = local.ecs_cluster_cond },
      { sid = "DescribeTask", actions = ["ecs:DescribeTasks", "ecs:DescribeTaskDefinition", "ecs:ListTasks", "ecs:StopTask"], resources = ["*"] },
      { sid = "PassRestoreRoleOnly", actions = ["iam:PassRole"], resources = var.refs.restore_passrole_arns, conditions = local.passed_to_ecs },
      {
        sid        = "RestoreIntoPinnedTargetOnly"
        actions    = ["rds:RestoreDBInstanceToPointInTime", "rds:RestoreDBInstanceFromDBSnapshot", "rds:AddTagsToResource"]
        resources  = ["arn:aws:rds:${var.region}:${var.account_id}:db:*", "arn:aws:rds:${var.region}:${var.account_id}:pg:*", "arn:aws:rds:${var.region}:${var.account_id}:og:*"]
        conditions = { StringEquals = { "aws:RequestTag/purpose" = "restore-test" } }
      },
      { sid = "RestoreUsesPinnedSubnetGroup", actions = ["rds:RestoreDBInstanceToPointInTime", "rds:RestoreDBInstanceFromDBSnapshot"], resources = compact([var.refs.restore_subnet_group_arn]) },
      { sid = "DeleteOnlyRestoreTestInstances", actions = ["rds:DeleteDBInstance"], resources = ["arn:aws:rds:${var.region}:${var.account_id}:db:*"], conditions = { StringEquals = { "aws:ResourceTag/purpose" = "restore-test" } } },
      { sid = "ObserveRestoredInstance", actions = ["rds:DescribeDBInstances", "rds:ListTagsForResource", "rds:DescribeDBSnapshots"], resources = ["*"] },
      { sid = "ReadBackupVault", actions = ["backup:Describe*", "backup:List*", "backup:GetRecoveryPointRestoreMetadata"], resources = ["*"] },
      { sid = "UsePinnedRestoreKey", actions = ["kms:Decrypt", "kms:DescribeKey", "kms:CreateGrant", "kms:GenerateDataKey*"], resources = compact([var.refs.restore_kms_key_arn]), conditions = { StringEquals = { "kms:ViaService" = "rds.${var.region}.amazonaws.com" } } },
      { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-restore-test"]] },
      { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
    ]

    "gh-audit-archive" = [
      { sid = "RunPinnedArchiveTaskOnly", actions = ["ecs:RunTask"], resources = compact([var.refs.audit_task_definition_arn]), conditions = local.ecs_cluster_cond },
      { sid = "DescribeTask", actions = ["ecs:DescribeTasks", "ecs:ListTasks"], resources = ["*"] },
      { sid = "PassArchiveRolesOnly", actions = ["iam:PassRole"], resources = var.refs.audit_passrole_arns, conditions = local.passed_to_ecs },
      { sid = "ReadArchiveTaskLog", actions = ["logs:GetLogEvents"], resources = var.refs.audit_log_group_arns },
      { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn["gh-audit-archive"]] },
      { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
    ]
  }

  # bootstrap and marketing roles exist per environment.
  allow_bootstrap = { for e in var.bootstrap_envs : "gh-bootstrap-${e}" => [
    { sid = "RunPinnedBootstrapTaskOnly", actions = ["ecs:RunTask"], resources = compact([var.refs.bootstrap_task_definition_arn]), conditions = local.ecs_cluster_cond },
    { sid = "DescribeTask", actions = ["ecs:DescribeTasks", "ecs:ListTasks"], resources = ["*"] },
    { sid = "PassBootstrapRolesOnly", actions = ["iam:PassRole"], resources = var.refs.bootstrap_passrole_arns, conditions = local.passed_to_ecs },
    { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter/approved/bootstrap-${e}"] },
    { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
    # G-1: cleanup.mjs describes and force-deletes the two token secrets (decision log 4 step 6). Deleting reads nothing:
    # NoSecretValueReads still denies GetSecretValue. A recovery window is refused by the condition.
    { sid = "DescribeTokenSecrets", actions = ["secretsmanager:DescribeSecret"], resources = ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:bootstrap/${e}/token/*"] },
    { sid = "ForceDeleteTokenSecrets", actions = ["secretsmanager:DeleteSecret"], resources = ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:bootstrap/${e}/token/*"], conditions = { Bool = { "secretsmanager:ForceDeleteWithoutRecovery" = "true" } } },
    # G-2: rotation as the final workflow step (decision log 4.1 item 1) and the task result from its log stream.
    { sid = "RotateBootstrapCredential", actions = ["secretsmanager:RotateSecret"], resources = ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${e}/db/app-bootstrap-*"] },
    { sid = "ReadBootstrapTaskLog", actions = ["logs:GetLogEvents"], resources = var.refs.bootstrap_log_group_arns },
  ] }
  allow_marketing = { for e in var.marketing_envs : "gh-deploy-marketing-${e}" => [
    { sid = "PublishSite", actions = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObject"], resources = flatten([for a in compact([lookup(var.refs.marketing_bucket_arns, e, null)]) : [a, "${a}/*"]]) },
    { sid = "InvalidateCache", actions = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], resources = compact([lookup(var.refs.marketing_distribution_arns, e, null)]) },
    { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter/approved/marketing-${e}"] },
    { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
  ] }

  # Each PassRole entry carries the service it is passed to (7.5, "explicit list").
  tf_passrole_conditioned = [for i, p in var.refs.workload_passrole : {
    sid        = "PassRole${i}"
    actions    = ["iam:PassRole"]
    resources  = [p.arn]
    conditions = { StringEquals = { "iam:PassedToService" = p.service } }
  }]

  record_read = { for n in ["gh-tf-staging", "gh-tf-production"] : n => [
    { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn[n]] },
    { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
  ] }

  # Portal switch and revert (live/<portal>/ written, releases/<sha>/ read) and the release store read (permission gaps 3-5).
  portal_statements = [
    { sid = "PortalLivePointerWrite", actions = ["s3:PutObject"], resources = [for a in compact([var.refs.portal_bucket_arn]) : "${a}/live/*"] },
    { sid = "PortalReleaseSourceRead", actions = ["s3:GetObject"], resources = flatten([for a in compact([var.refs.portal_bucket_arn, var.refs.release_store_read_arn]) : ["${a}/releases/*"]]) },
    { sid = "ReleaseManifestRead", actions = ["s3:GetObject"], resources = [for a in compact([var.refs.release_store_read_arn]) : "${a}/manifests/*"] },
    { sid = "PortalInvalidate", actions = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], resources = var.refs.portal_distribution_arns },
  ]

  # Deploy roles. `migrate` grants RunTask on the pinned migration definition only;
  # `rollout` grants UpdateService on named services; `smoke` needs only reads.
  deploy_statements = { for n in ["gh-deploy-staging", "gh-deploy-production"] : n => [
    { sid = "RunPinnedMigrationTaskOnly", actions = ["ecs:RunTask"], resources = compact([var.refs.migration_task_definition_arn]), conditions = local.ecs_cluster_cond, on = contains(local.granted[n], "*") || contains(local.granted[n], "migrate") },
    { sid = "UpdateNamedServices", actions = ["ecs:UpdateService"], resources = var.refs.service_arns, conditions = local.ecs_cluster_cond, on = contains(local.granted[n], "*") || contains(local.granted[n], "rollout") },
    { sid = "DescribeForSmokeAndMigration", actions = ["ecs:Describe*", "ecs:List*", "elasticloadbalancing:Describe*", "logs:DescribeLogGroups"], resources = ["*"] },
    { sid = "MigrationLogs", actions = ["logs:FilterLogEvents", "logs:GetLogEvents"], resources = var.refs.log_group_arns },
    { sid = "PassMigrationRolesOnly", actions = ["iam:PassRole"], resources = var.refs.migration_passrole_arns, conditions = local.passed_to_ecs },
    # Gaps 1-2: String parameters need no KMS grant. Never /approved/* (denied) and only the ARNs named in refs.
    { sid = "ReleaseConfigParameters", actions = ["ssm:GetParameter", "ssm:PutParameter"], resources = var.refs.release_config_parameter_arns },
    { sid = "BackupGateReads", actions = ["rds:DescribeDBInstances"], resources = var.refs.db_instance_arns },
    { sid = "BackupGateDescribeSnapshots", actions = ["rds:DescribeDBSnapshots"], resources = ["arn:aws:rds:${var.region}:${var.account_id}:snapshot:release-*-pre-migration"], on = length(var.refs.db_instance_arns) > 0 },
    { sid = "PreMigrationSnapshot", actions = ["rds:CreateDBSnapshot"], resources = concat(var.refs.db_instance_arns, ["arn:aws:rds:${var.region}:${var.account_id}:snapshot:release-*-pre-migration"]), on = length(var.refs.db_instance_arns) > 0 && (contains(local.granted[n], "*") || contains(local.granted[n], "migrate")) },
    { sid = "NoExecWhenEnabledOnRunOrUpdate", effect = "Deny", actions = ["ecs:RunTask", "ecs:UpdateService"], resources = ["*"], conditions = { Bool = { "ecs:enable-execute-command" = "true" } } },
    { sid = "RecordRead", actions = ["ssm:GetParameter"], resources = [local.records_arn[n]] },
    { sid = "RecordKeyDecrypt", actions = ["kms:Decrypt"], resources = [var.ssm_kms_key_arn] },
  ] if contains(keys(local.roles), n) }

  all_allow = merge(local.allow, local.allow_bootstrap, local.allow_marketing)

  statements = { for n, r in local.roles : n => [
    for s in concat(local.all_allow[n], local.deny_common) : merge(local.d, s) if
    merge(local.d, s).on && (merge(local.d, s).not_res != null || length(coalesce(merge(local.d, s).resources, [])) > 0)
  ] }

  policy = { for n in keys(local.roles) : n => jsonencode({
    Version = "2012-10-17"
    Statement = [for s in local.statements[n] : merge(
      { Sid = s.sid, Effect = s.effect, Action = s.actions },
      s.not_res != null ? { NotResource = s.not_res } : { Resource = s.resources },
      length(s.conditions) > 0 ? { Condition = s.conditions } : {},
    )]
  }) }
}
