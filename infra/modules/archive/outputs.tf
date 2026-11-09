output "archive_bucket_name" {
  value = aws_s3_bucket.archive.id
}

output "archive_bucket_arn" {
  value = aws_s3_bucket.archive.arn
}

output "archive_replica_bucket_arn" {
  value = aws_s3_bucket.replica.arn
}

output "backup_vault_arn" {
  description = "Vault-locked vault in the log-archive account (primary Region); the production backup plan copies into it."
  value       = aws_backup_vault.primary.arn
}

output "recovery_backup_vault_arn" {
  description = "Vault-locked vault in the recovery Region; null when disabled."
  value       = one(aws_backup_vault.recovery[*].arn)
}
