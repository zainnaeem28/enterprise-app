# Second line of defence against PHI in logs (DEVOPS-PLAN 11.1). It does not replace the logger allowlist (NFR-18, SEC-D-07).
# Audit + de-identify statements per log group; findings go to a dedicated group and raise the phi_pattern_in_logs alarm.
# Unverified until staging: the managed identifier names and that the service accepts this policy document.

locals {
  # Synthetic canary shape used by tests and canary traffic: PHI-CANARY-<8+ upper-case alphanumerics>.
  canary_regex = "PHI-CANARY-[A-Z0-9]{8,}"

  custom_identifiers = [
    { Name = "PhiCanary", Regex = local.canary_regex },
    { Name = "BearerToken", Regex = "[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}" },
    { Name = "JwtLike", Regex = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}" },
    { Name = "DateOfBirthIso", Regex = "(?i)(dob|date_of_birth|birth_date)\\W{1,3}(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}" },
  ]
  managed_identifiers = [for n in var.data_protection_managed_identifiers : "arn:aws:dataprotection::aws:data-identifier/${n}"]

  protect_groups = var.enable_core ? toset(var.log_group_names) : toset([])

  data_protection_policy = {
    Name        = "${var.name}-phi-log-protection"
    Description = "Audit and mask PHI-like patterns in application logs. Second line of defence behind the logger allowlist."
    Version     = "2021-06-01"
    Configuration = {
      CustomDataIdentifier = local.custom_identifiers
    }
    Statement = [
      {
        Sid            = "audit"
        DataIdentifier = concat(local.managed_identifiers, [for c in local.custom_identifiers : c.Name])
        Operation = {
          Audit = {
            FindingsDestination = {
              CloudWatchLogs = { LogGroup = aws_cloudwatch_log_group.findings.name }
            }
          }
        }
      },
      {
        Sid            = "deidentify"
        DataIdentifier = concat(local.managed_identifiers, [for c in local.custom_identifiers : c.Name])
        Operation      = { Deidentify = { MaskConfig = {} } }
      },
    ]
  }
}

resource "aws_cloudwatch_log_group" "findings" {
  # checkov:skip=CKV_AWS_338:Operational log, 30-90 day retention by design; application and security log retention is set in DEVOPS-PLAN 11.1 (final periods need counsel)
  name              = "/${var.name}/data-protection-findings"
  retention_in_days = var.findings_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_data_protection_policy" "app" {
  for_each        = local.protect_groups
  log_group_name  = each.value
  policy_document = jsonencode(local.data_protection_policy)
}
