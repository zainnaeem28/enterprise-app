module "network" {
  source = "../../modules/network"

  name                     = "staging"
  cidr_block               = var.vpc_cidr
  az_count                 = 2
  nat_per_az               = false
  flow_log_destination_arn = var.flow_log_bucket_arn
  tags                     = local.tags
}

# One KMS key per data class (RDS, S3 documents, secrets). Usage principals are
# added by the runtime tickets that create the roles; none are assumed here.
module "kms_data" {
  source             = "../../modules/kms"
  alias              = "staging-data"
  description        = "staging data at rest (RDS, S3)"
  multi_region       = true
  service_principals = ["rds.amazonaws.com", "s3.amazonaws.com"]
  tags               = local.tags
}

module "kms_secrets" {
  source             = "../../modules/kms"
  alias              = "staging-secrets"
  description        = "staging secrets and parameters"
  service_principals = ["secretsmanager.amazonaws.com", "ssm.amazonaws.com"]
  tags               = local.tags
}
