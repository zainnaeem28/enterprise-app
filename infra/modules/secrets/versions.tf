terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
      # Policy of the recovery-Region replicas; always passed by the caller, unused without recovery_region.
      configuration_aliases = [aws.recovery]
    }
  }
}
