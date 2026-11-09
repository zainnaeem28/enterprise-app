output "quarantine_bucket_name" {
  value = aws_s3_bucket.quarantine.id
}

output "quarantine_bucket_arn" {
  value = aws_s3_bucket.quarantine.arn
}

output "clean_bucket_name" {
  value = aws_s3_bucket.clean.id
}

output "clean_bucket_arn" {
  value = aws_s3_bucket.clean.arn
}

output "replica_bucket_arn" {
  description = "Recovery-Region clean bucket; null when replication is disabled."
  value       = one(aws_s3_bucket.replica[*].arn)
}
