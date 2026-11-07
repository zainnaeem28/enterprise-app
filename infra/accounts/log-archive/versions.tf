terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
  backend "s3" {
    # Partial configuration: bucket, region, kms_key_id come from backend.hcl.
    key          = "accounts/log-archive/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

variable "primary_region" {
  type    = string
  default = "us-east-2"
}

variable "apply_role_arn" {
  description = "Role in the log-archive account that this root is applied as (gh-tf-* for workload roots, human admin for first apply). Never a long-lived key."
  type        = string
}

locals {
  tags = { Project = "ehr-platform", ManagedBy = "opentofu", Root = "accounts/log-archive" }
}

provider "aws" {
  region = var.primary_region
  assume_role { role_arn = var.apply_role_arn }
  default_tags { tags = local.tags }
}
