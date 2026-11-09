# The tooling account hosts the state backend (infra/bootstrap), ECR and build
# roles. State bucket: infra/bootstrap. The approvals root (own state bucket and
# key) is a separate root owned by a later ticket, outside this ticket's paths.
# This root intentionally declares no resources yet; it exists so every
# account has exactly one root and one state object.
data "aws_caller_identity" "current" {}

output "account_id" {
  value = data.aws_caller_identity.current.account_id
}
