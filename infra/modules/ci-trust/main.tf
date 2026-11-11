# GitHub OIDC trust, deny-by-default roles and approved-release records.
# DEVOPS-PLAN 4.1 A2, 7.1, 7.2, 7.4, 7.5. This module is applied only by
# platform-admin-apply from infra/approvals (human, MFA). No gh-* role can apply it.

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
  tags           = var.tags
}

# Validations that need the catalog live here: variable validation cannot read locals.
resource "terraform_data" "checks" {
  input = sort(keys(var.records))

  lifecycle {
    precondition {
      condition     = alltrue([for r in var.role_names : contains(keys(local.catalog), r)])
      error_message = "role_names contains a name that is not in the catalog (locals.tf). Check bootstrap_envs and marketing_envs for per-environment roles."
    }
    precondition {
      condition     = alltrue([for k in keys(var.records) : contains(local.known_records, k)])
      error_message = "A record name is not one of ci, staging-release, staging-infra, staging-rehearsal, release, recover, infra, restore-test, audit-archive, bootstrap-<env> or marketing-<env> for a listed environment."
    }
    precondition {
      condition     = alltrue([for k in keys(var.records) : contains([for r in local.roles : r.record], k)])
      error_message = "A record has no role in this instance. Pass each root only the records for the roles it creates (a record enables no other role, 7.4)."
    }
    precondition {
      condition = alltrue([for k, r in var.records :
        timecmp(r.expires, r.not_before) > 0 && timecmp(timeadd(r.not_before, "${local.record_kinds[local.record_kind[k]].max_hours}h"), r.expires) >= 0
      ])
      error_message = "A record's expires must be after not_before and within the maximum window for its kind: release, recover, infra, staging-* and marketing-* use release_window_max_hours; audit-archive and bootstrap-<env> 24 h; ci and restore-test 8760 h (7.4)."
    }
    precondition {
      condition     = alltrue([for k, r in var.records : length(distinct(r.approvals)) >= local.record_kinds[local.record_kind[k]].min_approvals])
      error_message = "audit-archive and bootstrap-<env> records need at least two distinct human approvals; every record needs at least one (4.1 A2)."
    }
    precondition {
      condition     = alltrue([for k, r in var.records : !contains(r.approvals, r.applier) || length(distinct(r.approvals)) >= 2])
      error_message = "A single approver may not also apply their own approval; the applier is a second person, or one of at least two distinct approvers (4.1 A2)."
    }
    precondition {
      condition = alltrue([for k, r in var.records :
        !contains(["release", "recover", "staging-release"], local.record_kind[k]) || (startswith(r.manifest_hash, "sha256:") && length(r.manifest_hash) == 71)
      ])
      error_message = "release, recover and staging-release records need manifest_hash as sha256:<64 hex>."
    }
    precondition {
      condition = alltrue([for k, r in var.records :
        local.record_kind[k] != "recover" || (startswith(r.previous_manifest, "sha256:") && length(r.previous_manifest) == 71)
      ])
      error_message = "A recover record must name previous_manifest (the rollback target)."
    }
    precondition {
      condition = alltrue([for k, r in var.records :
        local.record_kind[k] != "release" || r.first_release || (startswith(r.previous_manifest, "sha256:") && length(r.previous_manifest) == 71)
      ])
      error_message = "A release record needs previous_manifest unless first_release is true (only the first production release may omit it, 7.4)."
    }
    precondition {
      condition = alltrue([for k, r in var.records : local.record_kind[k] != "bootstrap" || (
        length(coalesce(r.custodians, [])) == 2 && length(distinct([for c in coalesce(r.custodians, []) : c.identity_center_user_id])) == 2 &&
        length(distinct([for c in coalesce(r.custodians, []) : c.role_arn])) == 2 &&
        length(coalesce(r.enrollees, [])) == 2 && length(distinct([for e in coalesce(r.enrollees, []) : e.handle])) == 2 &&
        length(distinct([for e in coalesce(r.enrollees, []) : e.identity_arn])) == 2 &&
        length(coalesce(r.ticket_ref, "")) > 0 && length(coalesce(r.security_contact_verified_at, "")) > 0 && length(coalesce(r.security_contact_test_ref, "")) > 0
      )])
      error_message = "A bootstrap-<env> record needs two custodians (distinct user IDs and role ARNs), two enrollees (distinct handles and identity ARNs), ticket_ref, security_contact_verified_at and security_contact_test_ref (scripts/bootstrap/lib/record.mjs reads the same names)."
    }
    precondition {
      condition     = alltrue([for k, r in var.records : r.environment == one(distinct([for ro in local.roles : ro.record_env if ro.record == k]))])
      error_message = "A record's environment must equal the environment of the roles it enables."
    }
    precondition {
      condition     = alltrue([for n, p in local.policy : length(p) <= 10240])
      error_message = "A rendered role policy exceeds the 10,240-character inline limit."
    }
  }
}

# One boundary per instance, repeating the denials of the SCP (7.5): no IAM write,
# no task-definition registration or shell, no approvals records or state, and
# PassRole only to the roles named in refs.
locals {
  all_passrole_arns = distinct(concat(
    var.refs.migration_passrole_arns, var.refs.restore_passrole_arns, var.refs.audit_passrole_arns,
    var.refs.bootstrap_passrole_arns, var.refs.recover_passrole_arns, var.refs.rehearsal_passrole_arns,
    [for p in var.refs.workload_passrole : p.arn],
  ))
  boundary = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{ Sid = "AllowWithinRoleOwnPolicies", Effect = "Allow", Action = "*", Resource = "*" }],
      [for s in local.deny_common : merge(
        { Sid = s.sid, Effect = "Deny", Action = s.actions },
        s.not_res != null ? { NotResource = s.not_res } : { Resource = s.resources },
      )],
      [merge(
        { Sid = "PassRoleOnlyToNamedRoles", Effect = "Deny", Action = "iam:PassRole" },
        length(local.all_passrole_arns) > 0 ? { NotResource = local.all_passrole_arns } : {},
        length(local.all_passrole_arns) > 0 ? {} : { Resource = "*" },
      )],
    )
  })
}

resource "aws_iam_policy" "boundary" {
  name        = "gh-role-permission-boundary"
  description = "Permission boundary for every gh-* role (DEVOPS-PLAN 7.5)."
  policy      = local.boundary
  tags        = var.tags
}

resource "aws_iam_role" "gh" {
  for_each             = local.roles
  name                 = each.key
  description          = "GitHub Actions role. Denied until record '${each.value.record}' is applied by a human platform admin (DEVOPS-PLAN 7.4)."
  assume_role_policy   = local.trust[each.key]
  max_session_duration = each.value.session
  permissions_boundary = aws_iam_policy.boundary.arn
  tags                 = merge(var.tags, { Record = each.value.record, Environment = each.value.environment })

  depends_on = [terraform_data.checks]
}

resource "aws_iam_role_policy" "gh" {
  for_each = local.roles
  name     = "${each.key}-permissions"
  role     = aws_iam_role.gh[each.key].id
  policy   = local.policy[each.key]
}

# One authoritative record per purpose. Empty content = denied. A record is changed
# only by this human-applied change; no gh-* role may write /approved/* (explicit deny).
resource "aws_ssm_parameter" "record" {
  for_each    = toset([for r in local.roles : r.record])
  name        = "/approved/${each.key}"
  description = "Approved-release record '${each.key}'. Written only by the human-applied approvals root (DEVOPS-PLAN 7.4)."
  type        = "SecureString"
  key_id      = var.ssm_kms_key_arn
  value       = contains(keys(var.records), each.key) ? jsonencode({ for k, x in merge(var.records[each.key], { state = "approved" }) : k => x if x != null }) : jsonencode({ state = "empty" })
  tags        = var.tags
}
