# AWS Organizations: OU structure, member accounts and service control policies.
# DEVOPS-PLAN 3.1 and 7.5. Authored only. The management account holds no
# workload, no OIDC provider and no GitHub-assumable role (DEVOPS-PLAN 7.5).
#
# ASSUMPTIONS pending human decisions (stated in README.md):
#   C-12  the us-east-1 exemption list is the DEVOPS-PLAN 3.1 list, UNVERIFIED
#         for Chime SDK control plane and Cognito custom domain; the SCP is
#         therefore not attached (attach_scps = false) until verified.
#   C-21  the SCP owner is the platform-admin-apply holders; named people
#         are not assumed here.

data "aws_organizations_organization" "this" {}

locals {
  root_id    = data.aws_organizations_organization.this.roots[0].id
  us_regions = [var.primary_region, var.recovery_region]

  # Global services reached through us-east-1 endpoints (DEVOPS-PLAN 3.1).
  global_service_prefixes = [
    "iam:*", "organizations:*", "sts:*", "support:*", "budgets:*", "ce:*",
    "route53:*", "route53domains:*", "cloudfront:*", "acm:*", "wafv2:*",
    "account:*", "sso:*", "sso-directory:*", "identitystore:*",
  ]

  # us-east-1 allowances limited to named actions (DPR-21).
  us_east_1_alarm_actions = [
    "cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:DeleteAlarms",
    "sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:Publish", "sns:GetTopicAttributes",
  ]
}

# ---- OU structure ----------------------------------------------------------

resource "aws_organizations_organizational_unit" "security" {
  name      = "Security"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "infrastructure" {
  name      = "Infrastructure"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "workloads" {
  name      = "Workloads"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "workloads_prod" {
  name      = "Production"
  parent_id = aws_organizations_organizational_unit.workloads.id
}

resource "aws_organizations_organizational_unit" "workloads_nonprod" {
  name      = "NonProduction"
  parent_id = aws_organizations_organizational_unit.workloads.id
}

# ---- member accounts -------------------------------------------------------

resource "aws_organizations_account" "log_archive" {
  name                       = "log-archive"
  email                      = var.account_emails.log_archive
  parent_id                  = aws_organizations_organizational_unit.security.id
  role_name                  = "OrganizationAccountAccessRole"
  close_on_deletion          = false
  iam_user_access_to_billing = "DENY"
  lifecycle { ignore_changes = [role_name] }
}

resource "aws_organizations_account" "tooling" {
  name                       = "tooling"
  email                      = var.account_emails.tooling
  parent_id                  = aws_organizations_organizational_unit.infrastructure.id
  role_name                  = "OrganizationAccountAccessRole"
  close_on_deletion          = false
  iam_user_access_to_billing = "DENY"
  lifecycle { ignore_changes = [role_name] }
}

resource "aws_organizations_account" "staging" {
  name                       = "staging"
  email                      = var.account_emails.staging
  parent_id                  = aws_organizations_organizational_unit.workloads_nonprod.id
  role_name                  = "OrganizationAccountAccessRole"
  close_on_deletion          = false
  iam_user_access_to_billing = "DENY"
  lifecycle { ignore_changes = [role_name] }
}

resource "aws_organizations_account" "marketing" {
  name                       = "marketing"
  email                      = var.account_emails.marketing
  parent_id                  = aws_organizations_organizational_unit.workloads_nonprod.id
  role_name                  = "OrganizationAccountAccessRole"
  close_on_deletion          = false
  iam_user_access_to_billing = "DENY"
  lifecycle { ignore_changes = [role_name] }
}

resource "aws_organizations_account" "production" {
  name                       = "production"
  email                      = var.account_emails.production
  parent_id                  = aws_organizations_organizational_unit.workloads_prod.id
  role_name                  = "OrganizationAccountAccessRole"
  close_on_deletion          = false
  iam_user_access_to_billing = "DENY"
  lifecycle { ignore_changes = [role_name] }
}

# ---- service control policies ---------------------------------------------

# 1. Guardrails: never disable audit services, never delete the log vault, never leave the organisation.
data "aws_iam_policy_document" "guardrails" {
  statement {
    sid    = "DenyDisablingAuditAndDetection"
    effect = "Deny"
    actions = [
      "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors",
      "guardduty:DeleteDetector", "guardduty:DisassociateFromMasterAccount", "guardduty:UpdateDetector",
      "guardduty:DeleteMembers", "guardduty:StopMonitoringMembers",
      "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:DeleteDeliveryChannel",
    ]
    resources = ["*"]
  }
  statement {
    sid    = "DenyDeletingBackupVaultAndLogArchive"
    effect = "Deny"
    actions = [
      "backup:DeleteBackupVault", "backup:DeleteBackupVaultLockConfiguration",
      "backup:DeleteRecoveryPoint", "backup:PutBackupVaultAccessPolicy",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "DenyLeavingOrganization"
    effect    = "Deny"
    actions   = ["organizations:LeaveOrganization"]
    resources = ["*"]
  }
}

# 2. Region restriction: only the two US regions, plus the named us-east-1 exemptions.
#    Two statements: (a) deny everything outside the two regions except global
#    services (NotAction); (b) in us-east-1 allow only the global services and
#    the named alarm/topic actions, i.e. deny every other action there.
data "aws_iam_policy_document" "region_restriction" {
  statement {
    sid         = "DenyOutsideApprovedRegionsExceptGlobalServices"
    effect      = "Deny"
    not_actions = local.global_service_prefixes
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = concat(local.us_regions, ["us-east-1"])
    }
  }
  statement {
    sid         = "DenyUsEast1ExceptGlobalServicesAndNamedAlarmActions"
    effect      = "Deny"
    not_actions = concat(local.global_service_prefixes, local.us_east_1_alarm_actions)
    resources   = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["us-east-1"]
    }
  }
}

# 3. Control plane (DEVOPS-PLAN 7.5): only platform-admin-apply may touch /approved/*,
#    gh-*/bg-* trust and boundaries, the approvals key and state bucket, and org policies.
data "aws_iam_policy_document" "control_plane" {
  statement {
    sid       = "DenyApprovedParameterWrites"
    effect    = "Deny"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion"]
    resources = ["arn:aws:ssm:*:*:parameter/approved/*"]
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn_pattern]
    }
  }
  statement {
    sid    = "DenyPipelineRoleTrustAndBoundaryChanges"
    effect = "Deny"
    actions = [
      "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:DeleteRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary",
    ]
    resources = ["arn:aws:iam::*:role/gh-*", "arn:aws:iam::*:role/bg-*"]
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn_pattern]
    }
  }
  statement {
    sid       = "DenyApprovalsKeyPolicyChanges"
    effect    = "Deny"
    actions   = ["kms:PutKeyPolicy", "kms:ScheduleKeyDeletion"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Purpose"
      values   = ["approvals"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn_pattern]
    }
  }
  statement {
    sid       = "DenyApprovalsStateWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::*-approvals-state/*"]
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn_pattern]
    }
  }
  statement {
    sid    = "DenyOrganizationPolicyOperations"
    effect = "Deny"
    actions = [
      "organizations:CreatePolicy", "organizations:UpdatePolicy", "organizations:DeletePolicy",
      "organizations:AttachPolicy", "organizations:DetachPolicy",
    ]
    resources = ["*"]
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.platform_admin_role_arn_pattern]
    }
  }
}

resource "aws_organizations_policy" "guardrails" {
  name        = "ehr-guardrails"
  description = "Deny disabling CloudTrail/GuardDuty/Config, deleting the log vault, leaving the organisation."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.guardrails.json
}

resource "aws_organizations_policy" "region_restriction" {
  name        = "ehr-region-restriction"
  description = "Two US regions plus named us-east-1 exemptions (C-12, UNVERIFIED list)."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.region_restriction.json
}

resource "aws_organizations_policy" "control_plane" {
  name        = "ehr-control-plane-protection"
  description = "Only platform-admin-apply may change approvals, pipeline-role trust and org policies."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.control_plane.json
}

# Attached to the organisation root only when attach_scps = true (human decision after C-12 verification).
resource "aws_organizations_policy_attachment" "guardrails" {
  count     = var.attach_scps ? 1 : 0
  policy_id = aws_organizations_policy.guardrails.id
  target_id = local.root_id
}

resource "aws_organizations_policy_attachment" "region_restriction" {
  count     = var.attach_scps ? 1 : 0
  policy_id = aws_organizations_policy.region_restriction.id
  target_id = local.root_id
}

resource "aws_organizations_policy_attachment" "control_plane" {
  count     = var.attach_scps ? 1 : 0
  policy_id = aws_organizations_policy.control_plane.id
  target_id = local.root_id
}
