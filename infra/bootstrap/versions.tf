terraform {
  required_version = ">= 1.10.0" # S3 native state locking (use_lockfile)
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
  }
}

# Bootstrap runs once, by a human with the tooling-account admin role, using
# LOCAL state; it is then migrated into the bucket it creates (see README.md).
# It is authored only: nothing in this ticket applies it.
provider "aws" {
  region = var.primary_region
  default_tags { tags = local.tags }
}

provider "aws" {
  alias  = "recovery"
  region = var.recovery_region
  default_tags { tags = local.tags }
}
