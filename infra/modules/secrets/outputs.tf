output "secret_arns" {
  description = "ARNs by path. The approvals root grants the named task roles access to these ARNs."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "secret_names" {
  value = local.names
}

output "rotation_scheduled" {
  description = "Paths with a rotation schedule. Empty when no rotation function was supplied."
  value       = sort(keys(aws_secretsmanager_secret_rotation.this))
}

output "runtime_secret_prefixes" {
  description = "Paths created at runtime by the application roles (not IaC containers); the approvals root scopes the roles to these prefixes."
  value = {
    outbound = "${var.env}/integration/outbound/"
    inbound  = "${var.env}/integration/inbound/"
  }
}
