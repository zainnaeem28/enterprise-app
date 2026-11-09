output "db_instance_arn" {
  value = aws_db_instance.this.arn
}

output "db_instance_identifier" {
  value = aws_db_instance.this.identifier
}

output "endpoint_address" {
  description = "Writer endpoint host for the application's own (non-master) credentials."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "parameter_group_name" {
  value = aws_db_parameter_group.this.name
}

output "role_level_settings" {
  description = "Settings the login roles must carry (ALTER ROLE ... SET), applied by the F-03 roles bootstrap and checked by verification/transaction_timeout_probe.sql."
  value       = local.role_level_settings
}

output "backup_plan_id" {
  description = "AWS Backup plan id; null when no copy vault is configured."
  value       = one(aws_backup_plan.database[*].id)
}
