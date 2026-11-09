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
}

variables {
  name                 = "t"
  vpc_id               = "vpc-1"
  public_subnet_ids    = ["subnet-a", "subnet-b"]
  private_subnet_ids   = ["subnet-c", "subnet-d"]
  kms_key_arn          = "arn:aws:kms:us-east-2:111111111111:key/11111111-1111-1111-1111-111111111111"
  alb_certificate_arn  = "arn:aws:acm:us-east-2:111111111111:certificate/11111111-1111-1111-1111-111111111111"
  portal_hosts         = ["my.example.test", "staff.example.test", "pharmacy.example.test"]
  integrations_host    = "integrations.example.test"
  origin_verify_secret = "0123456789abcdef0123456789abcdef0123"
  access_logs_bucket   = "alb-logs"
  execution_role_arn   = "arn:aws:iam::111111111111:role/exec"
  services = {
    api = {
      image          = "111111111111.dkr.ecr.us-east-2.amazonaws.com/api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
      task_role_arn  = "arn:aws:iam::111111111111:role/api"
      cpu            = 1024
      memory         = 2048
      container_port = 3000
      attach_to_alb  = true
      desired_count  = 2
      min_count      = 2
      max_count      = 8
    }
    worker = {
      image         = "111111111111.dkr.ecr.us-east-2.amazonaws.com/worker@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      task_role_arn = "arn:aws:iam::111111111111:role/worker"
      cpu           = 512
      memory        = 1024
      attach_to_alb = false
      desired_count = 2
      min_count     = 2
      max_count     = 4
    }
  }
}

run "rollout_and_network_posture" {
  command = plan
  assert {
    condition     = alltrue([for s in aws_ecs_service.service : s.deployment_minimum_healthy_percent == 100 && s.deployment_maximum_percent == 150])
    error_message = "rolling deployment must be 100/150"
  }
  assert {
    condition     = alltrue([for s in aws_ecs_service.service : s.deployment_circuit_breaker[0].enable && s.deployment_circuit_breaker[0].rollback])
    error_message = "circuit breaker with rollback must be on"
  }
  assert {
    condition     = alltrue([for s in aws_ecs_service.service : s.network_configuration[0].assign_public_ip == false])
    error_message = "tasks must not have public IPs"
  }
  assert {
    condition     = aws_lb_target_group.service["api"].health_check[0].path == "/healthz" && length(aws_lb_target_group.service) == 1
    error_message = "only api is behind the ALB, health check is liveness"
  }
  assert {
    condition     = aws_lb.this.drop_invalid_header_fields == true && aws_lb.this.idle_timeout == 60
    error_message = "ALB hardening / SSE idle timeout"
  }
  assert {
    condition     = aws_appautoscaling_target.service["api"].max_capacity == 8 && aws_appautoscaling_target.service["worker"].max_capacity == 4
    error_message = "ceilings from the connection budget"
  }
}

run "integrations_rule_has_no_path_or_header_dependency" {
  command = plan
  assert {
    condition     = aws_lb_listener_rule.integrations.priority == 20 && aws_lb_listener_rule.portal_api.priority == 10
    error_message = "rule order"
  }
}

run "tag_image_rejected" {
  command = plan
  variables {
    services = {
      api = {
        image          = "repo/api:latest"
        task_role_arn  = "arn:aws:iam::111111111111:role/api"
        cpu            = 1024
        memory         = 2048
        container_port = 3000
        attach_to_alb  = true
        desired_count  = 2
        min_count      = 2
        max_count      = 8
      }
    }
  }
  expect_failures = [var.services]
}

run "api_ceiling_over_budget_rejected" {
  command = plan
  variables {
    services = {
      api = {
        image          = "repo/api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
        task_role_arn  = "arn:aws:iam::111111111111:role/api"
        cpu            = 1024
        memory         = 2048
        container_port = 3000
        attach_to_alb  = true
        desired_count  = 2
        min_count      = 2
        max_count      = 9
      }
    }
  }
  expect_failures = [var.services]
}

run "heartbeat_longer_than_timeout_rejected" {
  command = plan
  variables {
    sse_heartbeat_seconds = 45
  }
  expect_failures = [aws_lb.this]
}

run "backend_is_https_by_default" {
  command = plan
  assert {
    condition     = aws_lb_target_group.service["api"].protocol == "HTTPS" && aws_lb_target_group.service["api"].health_check[0].protocol == "HTTPS"
    error_message = "ALB to task must be HTTPS by default"
  }
}

run "plaintext_backend_rejected_in_production" {
  command = plan
  variables {
    plaintext_backend_exception_ref = "HEAAA-0"
    services = {
      api = {
        image            = "111111111111.dkr.ecr.us-east-2.amazonaws.com/api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
        task_role_arn    = "arn:aws:iam::111111111111:role/api"
        cpu              = 1024
        memory           = 2048
        container_port   = 3000
        backend_protocol = "HTTP"
        attach_to_alb    = true
        desired_count    = 2
        min_count        = 2
        max_count        = 8
      }
    }
  }
  expect_failures = [var.services]
}
