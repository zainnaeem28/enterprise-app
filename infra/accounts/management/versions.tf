terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
  }
  backend "s3" {
    # Partial configuration: bucket, region, kms_key_id come from backend.hcl
    # (tofu init -backend-config=backend.hcl). Only the key is fixed here.
    key          = "accounts/management/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

# Organizations is a global service reached through us-east-1 (DEVOPS-PLAN 3.1 exemptions).
provider "aws" {
  region = "us-east-1"
  default_tags { tags = { Project = "ehr-platform", ManagedBy = "opentofu", Root = "accounts/management" } }
}
