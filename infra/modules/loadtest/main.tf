# Ephemeral, production-equivalent load-test environment (DEVOPS-PLAN 3.4, 5.3, 13.1;
# TEST-CASES ENV-LOAD). Same modules and sizing as production (profile.tf), created per
# run from this module, destroyed after the run. Authored and plan-checked only: nothing
# in this ticket applies it. Decision log: HEAAA-586 D-1.

locals {
  env_name    = "loadtest-${var.run_id}"
  name_prefix = local.env_name

  tags = {
    Environment = "loadtest"
    RunId       = var.run_id
    owner       = var.owner
    ttl         = var.expires_at
    DataClass   = "synthetic-only"
    ManagedBy   = "opentofu"
  }

  # Synthetic-only data and stubbed integrations are part of the environment contract.
  # The application tickets must honour these two settings; they are not verified here.
  service_environment = {
    LOADTEST_SYNTHETIC_ONLY = "true"
    INTEGRATIONS_MODE       = "stub"
  }
}

module "network" {
  source = "../network"

  name                     = local.env_name
  cidr_block               = var.cidr_block
  az_count                 = local.profile.az_count
  nat_per_az               = local.profile.nat_per_az
  flow_log_destination_arn = var.flow_log_destination_arn
  tags                     = local.tags
}

module "kms_data" {
  source             = "../kms"
  alias              = "${local.env_name}-data"
  description        = "${local.env_name} synthetic data at rest (RDS, S3)"
  multi_region       = true
  service_principals = ["rds.amazonaws.com", "s3.amazonaws.com"]
  # Short window: the key belongs to a throw-away environment.
  deletion_window_in_days = 7
  tags                    = local.tags
}

module "kms_logs" {
  source                  = "../kms"
  alias                   = "${local.env_name}-logs"
  description             = "${local.env_name} log groups"
  service_principals      = ["logs.${data.aws_region.current.name}.amazonaws.com"]
  deletion_window_in_days = 7
  tags                    = local.tags
}

data "aws_region" "current" {}

resource "aws_kms_replica_key" "data_recovery" {
  provider                = aws.recovery
  description             = "${local.env_name} data key replica (document-bucket replication target)"
  primary_key_arn         = module.kms_data.key_arn
  deletion_window_in_days = 7
  tags                    = local.tags
}

module "database" {
  source = "../database"
  providers = {
    aws          = aws
    aws.recovery = aws.recovery
  }

  name_prefix               = local.name_prefix
  vpc_id                    = module.network.vpc_id
  data_subnet_ids           = module.network.data_subnet_ids
  client_security_group_ids = module.compute.service_security_group_ids
  kms_key_arn               = module.kms_data.key_arn

  engine_version           = local.profile.database.engine_version
  instance_class           = local.profile.database.instance_class
  multi_az                 = local.profile.database.multi_az
  allocated_storage_gb     = local.profile.database.allocated_storage_gb
  max_allocated_storage_gb = local.profile.database.max_allocated_storage_gb
  backup_retention_days    = local.profile.database.backup_retention_days

  # Documented differences from production (see profile.tf).
  deletion_protection                 = false
  recovery_backup_replication_enabled = false
  backup_copy_vault_arns              = []

  tags = local.tags
}

module "storage" {
  source = "../storage"
  providers = {
    aws          = aws
    aws.recovery = aws.recovery
  }

  name_prefix         = local.name_prefix
  kms_key_arn         = module.kms_data.key_arn
  replica_kms_key_arn = aws_kms_replica_key.data_recovery.arn
  replication_enabled = true
  force_destroy       = true
  # The clean bucket is written by the scanner role only in production; loadtest uses
  # the api and worker task roles of this run.
  clean_writer_principal_arns = [for s in values(var.services) : s.task_role_arn]
  tags                        = local.tags
}

module "compute" {
  source = "../compute"

  name               = local.name_prefix
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids
  kms_key_arn        = module.kms_logs.key_arn

  alb_certificate_arn  = var.alb_certificate_arn
  portal_hosts         = values(var.portal_hosts)
  integrations_host    = var.integrations_host
  origin_verify_secret = var.origin_verify_secret
  access_logs_bucket   = var.access_logs_bucket
  access_logs_prefix   = "alb/${local.env_name}"
  execution_role_arn   = var.execution_role_arn

  alb_idle_timeout_seconds               = local.profile.alb_idle_timeout_seconds
  sse_heartbeat_seconds                  = local.profile.sse_heartbeat_seconds
  cloudfront_origin_read_timeout_seconds = local.profile.cloudfront_origin_read_timeout_seconds

  # Production code path: ALB-to-task is HTTPS, no plaintext exception. Torn down after the run.
  environment_class   = "production"
  deletion_protection = false

  database_security_group_ids = { database = module.database.security_group_id }

  services = {
    for k, s in local.profile.services : k => merge(s, {
      image         = var.services[k].image
      task_role_arn = var.services[k].task_role_arn
      environment   = local.service_environment
    })
  }

  tags = local.tags
}

module "edge" {
  source = "../edge"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                          = local.name_prefix
  portals                       = { for k, h in var.portal_hosts : k => { host = h } }
  integrations_host             = var.integrations_host
  cloudfront_certificate_arn    = var.cloudfront_certificate_arn
  alb_arn                       = module.compute.alb_arn
  alb_dns_name                  = module.compute.alb_dns_name
  origin_verify_secret          = var.origin_verify_secret
  origin_read_timeout_seconds   = local.profile.cloudfront_origin_read_timeout_seconds
  cloudfront_logs_bucket_domain = var.cloudfront_logs_bucket_domain
  waf_log_group_arn_cloudfront  = var.waf_log_group_arn_cloudfront
  waf_log_group_arn_regional    = var.waf_log_group_arn_regional
  tags                          = local.tags
}

# One-off synthetic-data generator. Run by the harness (`seed.sh`), not a service.
resource "aws_cloudwatch_log_group" "seeder" {
  name              = "/${local.env_name}/seeder"
  retention_in_days = 14
  kms_key_id        = module.kms_logs.key_arn
  tags              = local.tags
}

resource "aws_ecs_task_definition" "seeder" {
  family                   = "${local.name_prefix}-seeder"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.seeder.task_role_arn

  container_definitions = jsonencode([{
    name      = "seeder"
    image     = var.seeder.image
    essential = true
    environment = [
      { name = "SEED", value = tostring(var.seeder.seed) },
      { name = "SEED_COUNTS", value = jsonencode(var.seeder.counts) },
      { name = "LOADTEST_SYNTHETIC_ONLY", value = "true" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.seeder.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "seeder"
      }
    }
    readonlyRootFilesystem = true
  }])
  tags = local.tags
}

# Cost guardrail: a budget on everything tagged to this environment. Exceeding it stops
# the run (harness `guard-cost.sh`) and is reported, never absorbed.
resource "aws_budgets_budget" "run" {
  name         = "${local.env_name}-run"
  budget_type  = "COST"
  limit_amount = tostring(var.run_cost_ceiling_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:RunId$${var.run_id}"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_notification_emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_notification_emails
  }
}
