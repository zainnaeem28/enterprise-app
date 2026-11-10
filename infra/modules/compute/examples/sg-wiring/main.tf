# Minimal root wiring `compute` and `database` together the way every environment root does:
# the database client groups are compute's service groups and the compute egress targets are the
# database group. Both sets of ids are apply-time values on a fresh plan. Used only by
# tests/wiring.tftest.hcl (mock providers, no apply).
provider "aws" {}

provider "aws" {
  alias = "recovery"
}

module "compute" {
  source = "../.."

  name                 = "t"
  vpc_id               = "vpc-1"
  private_subnet_ids   = ["subnet-c", "subnet-d"]
  kms_key_arn          = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  alb_certificate_arn  = "arn:aws:acm:us-east-2:111111111111:certificate/11111111-1111-1111-1111-111111111111"
  portal_hosts         = ["my.example.test"]
  integrations_host    = "integrations.example.test"
  origin_verify_secret = "0123456789abcdef0123456789abcdef0123"
  access_logs_bucket   = "alb-logs"
  execution_role_arn   = "arn:aws:iam::111111111111:role/exec"

  database_security_group_ids = { database = module.database.security_group_id }

  services = {
    api = {
      image          = "111111111111.dkr.ecr.us-east-2.amazonaws.com/api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
      task_role_arn  = "arn:aws:iam::111111111111:role/api"
      cpu            = 1024
      memory         = 2048
      container_port = 3000
      attach_to_alb  = true
      desired_count  = 2
      min_count      = 2
      max_count      = 8
    }
    worker = {
      image         = "111111111111.dkr.ecr.us-east-2.amazonaws.com/worker@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      task_role_arn = "arn:aws:iam::111111111111:role/worker"
      cpu           = 512
      memory        = 1024
      attach_to_alb = false
      desired_count = 2
      min_count     = 2
      max_count     = 4
    }
  }
}

module "database" {
  source = "../../../database"
  providers = {
    aws          = aws
    aws.recovery = aws.recovery
  }

  name_prefix               = "t"
  vpc_id                    = "vpc-1"
  data_subnet_ids           = ["subnet-a", "subnet-b"]
  client_security_group_ids = module.compute.service_security_group_ids
  kms_key_arn               = "arn:aws:kms:us-east-1:111111111111:key/aaaa"
  recovery_kms_key_arn      = "arn:aws:kms:us-west-2:111111111111:key/bbbb"
  backup_copy_vault_arns    = ["arn:aws:backup:us-east-1:222222222222:backup-vault:v"]
}
