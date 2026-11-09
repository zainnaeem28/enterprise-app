output "role_arns" {
  description = "ARNs of the gh-* roles created by this instance."
  value       = { for n, r in aws_iam_role.gh : n => r.arn }
}

output "role_state" {
  description = "Per role: record name and whether a record currently enables it. Everything is false until a human applies a record."
  value       = { for n, r in local.roles : n => { record = r.record, enabled = local.enabled[n], environment = r.environment, workflow = r.workflow } }
}

output "record_parameter_names" {
  value = { for k, p in aws_ssm_parameter.record : k => p.name }
}

output "boundary_policy_arn" {
  value = aws_iam_policy.boundary.arn
}

output "oidc_provider_arn" {
  value = local.oidc_provider_arn
}

output "trust_policies" {
  description = "Rendered trust policies, for the plan artifact and review."
  value       = local.trust
}

output "role_policies" {
  description = "Rendered inline policies, for the plan artifact and review."
  value       = local.policy
}
