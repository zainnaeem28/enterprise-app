# Root for the DR rehearsal stack (DEVOPS-PLAN 10.4). Run by scripts/restore/dr-rehearsal.sh under the staging rehearsal role,
# never from a laptop with production credentials: the module refuses any account but `expected_account_id` and any Region
# but the recovery Region. State lives in the staging account's backend; the bucket, key and lock table come from a
# -backend-config file that is not committed. Authored, not applied.

terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.expected_region
  default_tags {
    tags = { Project = "ehr-platform", ManagedBy = "opentofu", Root = "dr-rehearsal" }
  }
}

variable "expected_account_id" { type = string }
variable "expected_region" {
  type    = string
  default = "us-west-2"
}
variable "vpc_cidr" { type = string }
variable "flow_log_destination_arn" { type = string }
variable "snapshot_arn" { type = string }
variable "expires_at" { type = string }
variable "rehearsal_id" { type = string }
variable "db_instance_class" {
  type    = string
  default = "db.r6g.large"
}

module "rehearsal" {
  source = "../"

  expected_account_id      = var.expected_account_id
  expected_region          = var.expected_region
  vpc_cidr                 = var.vpc_cidr
  flow_log_destination_arn = var.flow_log_destination_arn
  snapshot_arn             = var.snapshot_arn
  expires_at               = var.expires_at
  rehearsal_id             = var.rehearsal_id
  db_instance_class        = var.db_instance_class
}

# Read by dr-rehearsal.sh (`sweep`) and by the rehearsal steps.
output "expires_at" {
  value = module.rehearsal.expires_at
}

output "database_endpoint" {
  value = module.rehearsal.database_endpoint
}

output "ecs_cluster_name" {
  value = module.rehearsal.ecs_cluster_name
}

output "database_security_group_id" {
  value = module.rehearsal.database_security_group_id
}
