mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-2a", "us-east-2b", "us-east-2c"] }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-2" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111" }
  }
}

variables {
  vpc_cidr                  = "10.90.0.0/22"
  flow_log_destination_arn  = "arn:aws:s3:::flow-bucket"
  result_bucket_name        = "log-archive-results"
  result_bucket_kms_key_arn = "arn:aws:kms:us-east-2:222222222222:key/22222222-2222-2222-2222-222222222222"
  ecr_repository_arn        = "arn:aws:ecr:us-east-2:111111111111:repository/ehr/restore"
  image_repository_url      = "111111111111.dkr.ecr.us-east-2.amazonaws.com/ehr/restore"
  image_digest              = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

run "no_way_out_of_the_vpc_except_endpoints" {
  command = apply

  assert {
    condition     = length(aws_subnet.restore) == 2 && alltrue([for s in aws_subnet.restore : s.map_public_ip_on_launch == false])
    error_message = "two private subnets, no public IPs"
  }
  assert {
    condition     = length(aws_route_table.restore.route) == 0
    error_message = "the restore route table carries no inline route (no internet gateway, NAT, peering or transit route)"
  }
  assert {
    condition     = toset(keys(aws_vpc_endpoint.interface)) == toset(["ecr-api", "ecr-dkr", "logs", "rds", "sts", "kms"])
    error_message = "exactly the six interface endpoints the task needs"
  }
  assert {
    condition     = alltrue([for e in aws_vpc_endpoint.interface : e.private_dns_enabled && length(e.policy) > 2])
    error_message = "every interface endpoint has private DNS and a policy"
  }
  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" && length(aws_vpc_endpoint.s3.policy) > 2
    error_message = "S3 is a gateway endpoint with a policy"
  }
}

run "the_task_definition_is_pinned_by_digest_with_a_fixed_entry_point" {
  command = plan

  assert {
    condition     = strcontains(aws_ecs_task_definition.restore.container_definitions, "@sha256:0000000000000000000000000000000000000000000000000000000000000000")
    error_message = "image is pinned by digest"
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.restore.container_definitions)[0].entryPoint == ["node", "scripts/restore/task/restore-check.mjs"]
    error_message = "fixed entry point"
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.restore.container_definitions)[0].readonlyRootFilesystem == true && jsondecode(aws_ecs_task_definition.restore.container_definitions)[0].privileged == false
    error_message = "read-only root file system, not privileged"
  }
  assert {
    condition     = !strcontains(aws_ecs_task_definition.restore.container_definitions, "\"secrets\"")
    error_message = "no secret is injected into the task; passwords are generated in the process"
  }
}

run "a_tag_is_refused" {
  command = plan
  variables {
    image_digest = "latest"
  }
  expect_failures = [var.image_digest]
}

run "a_wide_cidr_is_refused" {
  command = plan
  variables {
    vpc_cidr = "10.90.0.0/16"
  }
  expect_failures = [var.vpc_cidr]
}

run "targets_are_private_and_in_the_pinned_group" {
  command = plan

  assert {
    condition     = aws_db_subnet_group.restore.name == "restore-test-targets"
    error_message = "subnet group name"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.target_from_task.referenced_security_group_id) > 0 && aws_vpc_security_group_ingress_rule.target_from_task.from_port == 5432
    error_message = "the target accepts PostgreSQL from the task security group only"
  }
}

run "without_an_alert_topic_the_rule_has_no_target" {
  command = plan
  assert {
    condition     = length(aws_cloudwatch_event_target.restore_calls) == 0
    error_message = "no target without a topic"
  }
}

run "with_an_alert_topic_the_rule_has_a_target" {
  command = plan
  variables {
    alert_topic_arn = "arn:aws:sns:us-east-2:111111111111:security"
  }
  assert {
    condition     = length(aws_cloudwatch_event_target.restore_calls) == 1
    error_message = "target present with a topic"
  }
}
