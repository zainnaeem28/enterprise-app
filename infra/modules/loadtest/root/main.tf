# Thin root used to initialise, validate, lint, scan and plan the module with the provider
# aliases wired. Regions follow the production roots (primary us-east-2, recovery
# us-west-2). No backend: this root is never applied; a real run supplies state
# configuration in the approved pipeline.
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = "us-east-2"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "aws" {
  alias  = "recovery"
  region = "us-west-2"
}

variable "run_id" { type = string }
variable "owner" { type = string }
variable "expires_at" { type = string }
variable "flow_log_destination_arn" { type = string }
variable "alb_certificate_arn" { type = string }
variable "cloudfront_certificate_arn" { type = string }
variable "portal_hosts" { type = map(string) }
variable "integrations_host" { type = string }
variable "origin_verify_secret" {
  type      = string
  sensitive = true
}
variable "access_logs_bucket" { type = string }
variable "cloudfront_logs_bucket_domain" { type = string }
variable "waf_log_group_arn_cloudfront" { type = string }
variable "waf_log_group_arn_regional" { type = string }
variable "execution_role_arn" { type = string }
variable "services" {
  type = map(object({
    image         = string
    task_role_arn = string
  }))
}
variable "seeder" {
  type = object({
    image         = string
    task_role_arn = string
    seed          = number
    counts        = map(number)
  })
}
variable "run_cost_ceiling_usd" { type = number }
variable "budget_notification_emails" { type = list(string) }

module "loadtest" {
  source = "../"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }

  run_id                        = var.run_id
  owner                         = var.owner
  expires_at                    = var.expires_at
  flow_log_destination_arn      = var.flow_log_destination_arn
  alb_certificate_arn           = var.alb_certificate_arn
  cloudfront_certificate_arn    = var.cloudfront_certificate_arn
  portal_hosts                  = var.portal_hosts
  integrations_host             = var.integrations_host
  origin_verify_secret          = var.origin_verify_secret
  access_logs_bucket            = var.access_logs_bucket
  cloudfront_logs_bucket_domain = var.cloudfront_logs_bucket_domain
  waf_log_group_arn_cloudfront  = var.waf_log_group_arn_cloudfront
  waf_log_group_arn_regional    = var.waf_log_group_arn_regional
  execution_role_arn            = var.execution_role_arn
  services                      = var.services
  seeder                        = var.seeder
  run_cost_ceiling_usd          = var.run_cost_ceiling_usd
  budget_notification_emails    = var.budget_notification_emails
}

output "environment" {
  value = module.loadtest.environment
}

output "profile" {
  value = module.loadtest.profile
}

output "seeder_run_task" {
  value = module.loadtest.seeder_run_task
}
