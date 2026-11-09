output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = module.state_key.key_arn
}

output "backend_config_hint" {
  description = "Values for each account root's backend.hcl (partial configuration)."
  value = {
    bucket       = aws_s3_bucket.state.id
    region       = var.primary_region
    encrypt      = true
    kms_key_id   = module.state_key.key_arn
    use_lockfile = true
  }
}
