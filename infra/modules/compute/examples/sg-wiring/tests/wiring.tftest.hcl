# Fresh plan of a root that wires compute and database together. Before the static-key change this
# failed with "Invalid for_each argument" because the rules were keyed on apply-time security group ids.
mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { name = "us-east-2" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-2:111111111111:loadbalancer/app/t-alb/1111111111111111"
      arn_suffix = "app/t-alb/1111111111111111"
    }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-2:111111111111:listener/app/t-alb/1111111111111111/2222222222222222" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-2:111111111111:targetgroup/api/3333333333333333"
      arn_suffix = "targetgroup/api/3333333333333333"
    }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-2:111111111111:task-definition/t-api:1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_db_instance" {
    defaults = { arn = "arn:aws:rds:us-east-1:111111111111:db:mock" }
  }
}

mock_provider "aws" {
  alias = "recovery"
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-replica" }
  }
}

run "fresh_plan_wires_security_groups" {
  command = plan

  assert {
    condition     = join(",", sort(keys(module.compute.service_security_group_ids))) == "api,worker"
    error_message = "database client groups are keyed by the static service names"
  }
}
