module "network" {
  source = "../../modules/network"

  name                     = "production"
  cidr_block               = var.vpc_cidr
  az_count                 = 3
  nat_per_az               = true
  flow_log_destination_arn = var.flow_log_bucket_arn
  tags                     = local.tags
}

# One KMS key per data class (RDS, S3 documents, secrets). Usage principals are
# added by the runtime tickets that create the roles; none are assumed here.
module "kms_data" {
  source             = "../../modules/kms"
  alias              = "production-data"
  description        = "production data at rest (RDS, S3)"
  multi_region       = true
  service_principals = ["rds.amazonaws.com", "s3.amazonaws.com"]
  tags               = local.tags
}

module "kms_secrets" {
  source             = "../../modules/kms"
  alias              = "production-secrets"
  description        = "production secrets and parameters"
  service_principals = ["secretsmanager.amazonaws.com", "ssm.amazonaws.com"]
  tags               = local.tags
}

# Recovery Region (us-west-2): VPC and replica key only. Compute is not pre-provisioned.
module "network_recovery" {
  source    = "../../modules/network"
  providers = { aws = aws.recovery }

  name                     = "production-dr"
  cidr_block               = "10.11.0.0/16"
  az_count                 = 2
  nat_per_az               = false
  flow_log_destination_arn = var.flow_log_bucket_arn
  tags                     = local.tags
}

# Key for the recovery-Region replicas of the secrets (the VAPID private key). Secrets Manager takes any key of the
# replica Region, so this is a separate single-Region key, not a replica of kms_secrets.
module "kms_secrets_recovery" {
  source             = "../../modules/kms"
  providers          = { aws = aws.recovery }
  alias              = "production-secrets-dr"
  description        = "production secret replicas (recovery Region)"
  service_principals = ["secretsmanager.amazonaws.com", "ssm.amazonaws.com"]
  tags               = local.tags
}

resource "aws_kms_replica_key" "data_recovery" {
  provider        = aws.recovery
  description     = "production data at rest (recovery Region replica)"
  primary_key_arn = module.kms_data.key_arn
  tags            = local.tags
}
