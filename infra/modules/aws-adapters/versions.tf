terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
      # Recovery-Region resources (recovery.tf). Always passed by the caller; nothing is created there without recovery_region.
      configuration_aliases = [aws.recovery]
    }
  }
}
