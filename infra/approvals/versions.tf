terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
    }
  }
  backend "s3" {
    # Partial configuration. The approvals root has its OWN state bucket and KMS key in
    # the tooling account, readable and writable only by platform-admin-apply
    # (DEVOPS-PLAN 7.5). Bucket and key come from backend.hcl, which is never committed.
    key          = "approvals/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
