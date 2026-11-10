# Checks with mock providers: `command = apply` against a mock provider creates nothing and
# uses no credentials; it is used because the sibling modules key for_each on security-group
# ids that a real fresh plan cannot know (see the module README, limitation L1).
# `terraform test -verbose` output is kept as the plan artifact.
mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { name = "us-east-2" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-2a", "us-east-2b", "us-east-2c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "aws" {
  alias = "recovery"
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

# The sibling modules have their own tests and some key for_each on apply-time ids, so they
# are replaced with fixed outputs; this file checks what loadtest itself adds (profile,
# tags, seeder task, budget, replica key, input validation).
override_module {
  target = module.network
  outputs = {
    vpc_id             = "vpc-0123"
    public_subnet_ids  = ["subnet-a", "subnet-b", "subnet-c"]
    private_subnet_ids = ["subnet-d", "subnet-e", "subnet-f"]
    data_subnet_ids    = ["subnet-g", "subnet-h", "subnet-i"]
  }
}
override_module {
  target = module.kms_data
  outputs = {
    key_arn = "arn:aws:kms:us-east-2:111111111111:key/mrk-11111111111111111111111111111111"
  }
}
override_module {
  target = module.kms_logs
  outputs = {
    key_arn = "arn:aws:kms:us-east-2:111111111111:key/33333333-3333-3333-3333-333333333333"
  }
}
override_module {
  target = module.database
  outputs = {
    security_group_id = "sg-0ddd"
  }
}
override_module {
  target  = module.storage
  outputs = {}
}
override_module {
  target  = module.edge
  outputs = {}
}
override_module {
  target = module.compute
  outputs = {
    alb_arn                    = "arn:aws:elasticloadbalancing:us-east-2:111111111111:loadbalancer/app/lt/1111111111111111"
    alb_dns_name               = "lt-1.us-east-2.elb.amazonaws.com"
    cluster_name               = "lt"
    service_security_group_ids = { api = "sg-0aaa", worker = "sg-0bbb" }
  }
}

variables {
  run_id                        = "20261110-01"
  owner                         = "devops-engineer"
  expires_at                    = timeadd(plantimestamp(), "12h")
  flow_log_destination_arn      = "arn:aws:s3:::example-flow-logs"
  alb_certificate_arn           = "arn:aws:acm:us-east-2:111111111111:certificate/11111111-1111-1111-1111-111111111111"
  cloudfront_certificate_arn    = "arn:aws:acm:us-east-1:111111111111:certificate/22222222-2222-2222-2222-222222222222"
  portal_hosts                  = { patient = "my.lt.example.test", staff = "staff.lt.example.test", pharmacy = "pharmacy.lt.example.test" }
  integrations_host             = "integrations.lt.example.test"
  origin_verify_secret          = "0123456789abcdef0123456789abcdef0123"
  access_logs_bucket            = "example-alb-logs"
  cloudfront_logs_bucket_domain = "example-cf-logs.s3.amazonaws.com"
  waf_log_group_arn_cloudfront  = "arn:aws:logs:us-east-1:111111111111:log-group:aws-waf-logs-lt-cf"
  waf_log_group_arn_regional    = "arn:aws:logs:us-east-2:111111111111:log-group:aws-waf-logs-lt-alb"
  execution_role_arn            = "arn:aws:iam::111111111111:role/lt-exec"
  services = {
    api    = { image = "111111111111.dkr.ecr.us-east-2.amazonaws.com/api@sha256:0000000000000000000000000000000000000000000000000000000000000000", task_role_arn = "arn:aws:iam::111111111111:role/lt-api" }
    worker = { image = "111111111111.dkr.ecr.us-east-2.amazonaws.com/worker@sha256:1111111111111111111111111111111111111111111111111111111111111111", task_role_arn = "arn:aws:iam::111111111111:role/lt-worker" }
  }
  seeder = {
    image         = "111111111111.dkr.ecr.us-east-2.amazonaws.com/seeder@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    task_role_arn = "arn:aws:iam::111111111111:role/lt-seeder"
    seed          = 20261110
    counts        = { patients = 200000, appointments = 2000000 }
  }
  run_cost_ceiling_usd       = 100
  budget_notification_emails = ["ops@example.test"]
}

run "production_equivalent_profile" {
  command = apply
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  assert {
    condition     = local.profile.database.instance_class == "db.r6i.xlarge" && local.profile.database.multi_az && local.profile.database.engine_version == "17"
    error_message = "database must be the production class, Multi-AZ, PostgreSQL 17"
  }
  assert {
    condition     = local.profile.az_count == 3 && local.profile.nat_per_az
    error_message = "network shape must match production (3 AZs, NAT per AZ)"
  }
  assert {
    condition     = local.profile.sse_heartbeat_seconds == 15 && local.profile.alb_idle_timeout_seconds == 60
    error_message = "SSE timing must match production"
  }
}

run "service_ceilings_match_connection_budget" {
  command = apply
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  assert {
    condition     = local.profile.services.api.max_count <= 8 && local.profile.services.worker.max_count <= 4 && alltrue([for s in values(local.profile.services) : s.min_count >= 2 && s.min_count <= s.desired_count && s.desired_count <= s.max_count])
    error_message = "task floor 2, api <= 8, worker <= 4 (compute module rules; compute is replaced in this test)"
  }
}

run "synthetic_only_and_tagged" {
  command = apply
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  assert {
    condition     = local.tags.DataClass == "synthetic-only" && local.tags.Environment == "loadtest" && local.tags.ttl == var.expires_at && local.tags.owner == var.owner
    error_message = "tags required by the reaper and cost guard"
  }
  assert {
    condition     = local.service_environment.INTEGRATIONS_MODE == "stub"
    error_message = "no real integrations"
  }
}

run "overlapping_cidr_rejected" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  variables {
    cidr_block = "10.10.0.0/16"
  }
  expect_failures = [var.cidr_block]
}

run "tag_image_rejected" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  variables {
    seeder = {
      image         = "repo/seeder:latest"
      task_role_arn = "arn:aws:iam::111111111111:role/lt-seeder"
      seed          = 1
      counts        = {}
    }
  }
  expect_failures = [var.seeder]
}

run "lifetime_over_24h_rejected" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    aws.recovery  = aws.recovery
  }
  variables {
    expires_at = timeadd(plantimestamp(), "48h")
  }
  expect_failures = [var.expires_at]
}
