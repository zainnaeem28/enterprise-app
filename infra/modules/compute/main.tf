data "aws_region" "current" {}

locals {
  tags = merge(var.tags, { Module = "compute" })

  alb_services = { for k, s in var.services : k => s if s.attach_to_alb }
}

# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Public ALB: 443 from anywhere (CloudFront origin requests and the integrations host); 80 only redirects"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

# The integrations host is reached directly from partner systems, so the ALB cannot be limited to
# CloudFront ranges. Portal hosts are protected by the origin-verify header rule below; both host
# types sit behind the regional WAF (edge module).
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet (WAF, host rules and origin-verify header apply)" # checkov:skip=CKV_AWS_260
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, answered only with a redirect to HTTPS" # checkov:skip=CKV_AWS_260
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  for_each                     = local.alb_services
  security_group_id            = aws_security_group.alb.id
  description                  = "To ${each.key} tasks"
  ip_protocol                  = "tcp"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  referenced_security_group_id = aws_security_group.service[each.key].id
}

resource "aws_lb" "this" {
  # checkov:skip=CKV2_AWS_28:The regional web ACL is created and associated in the edge module (aws_wafv2_web_acl_association.alb); the scanner cannot see across modules.
  name                       = "${var.name}-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  idle_timeout               = var.alb_idle_timeout_seconds
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = var.deletion_protection
  enable_http2               = true

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = var.access_logs_prefix
    enabled = true
  }

  tags = local.tags

  lifecycle {
    precondition {
      condition     = var.sse_heartbeat_seconds < var.alb_idle_timeout_seconds && var.sse_heartbeat_seconds < var.cloudfront_origin_read_timeout_seconds
      error_message = "The SSE heartbeat must be shorter than the ALB idle timeout and the CloudFront origin read timeout (ARCHITECTURE 5.4)."
    }
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn

  # Anything that is not an explicitly routed host is refused.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_target_group" "service" {
  # checkov:skip=CKV_AWS_378:TLS ends at the ALB; the ALB-to-task hop stays inside private subnets and is limited by security groups. Re-encryption to the task is an open decision for the Solution Architect (see infra/modules/compute/README.md).
  for_each = local.alb_services

  name_prefix          = substr(each.key, 0, 6)
  vpc_id               = var.vpc_id
  protocol             = "HTTP"
  port                 = each.value.container_port
  target_type          = "ip"
  deregistration_delay = var.deregistration_delay_seconds

  # Liveness only (/healthz). /readyz is for deploy gating, never for task replacement (DEVOPS-PLAN 9.1).
  health_check {
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

# Portal hosts: only requests carrying the CloudFront origin-verify header reach the API.
resource "aws_lb_listener_rule" "portal_api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header {
      values = var.portal_hosts
    }
  }
  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
  condition {
    http_header {
      http_header_name = var.origin_verify_header_name
      values           = [var.origin_verify_secret]
    }
  }

  tags = local.tags
}

# Machine clients: token and signature authentication in the API; cookies are rejected by the WAF
# (edge module) because an ALB rule cannot drop them.
resource "aws_lb_listener_rule" "integrations" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header {
      values = [var.integrations_host]
    }
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# ECS
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = var.services
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}

resource "aws_security_group" "service" {
  for_each    = var.services
  name_prefix = "${var.name}-${each.key}-"
  description = "${each.key} tasks"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-${each.key}" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  for_each                     = local.alb_services
  security_group_id            = aws_security_group.service[each.key].id
  description                  = "From the ALB"
  ip_protocol                  = "tcp"
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  referenced_security_group_id = aws_security_group.alb.id
}

# Outbound HTTPS to AWS APIs and external services (through NAT); no other egress.
resource "aws_vpc_security_group_egress_rule" "service_https" {
  for_each          = var.services
  security_group_id = aws_security_group.service[each.key].id
  description       = "HTTPS egress via NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "service_database" {
  for_each = {
    for pair in setproduct(keys(var.services), var.database_security_group_ids) :
    "${pair[0]}-${pair[1]}" => { service = pair[0], target = pair[1] }
  }
  security_group_id            = aws_security_group.service[each.value.service].id
  description                  = "To the database"
  ip_protocol                  = "tcp"
  from_port                    = var.database_port
  to_port                      = var.database_port
  referenced_security_group_id = each.value.target
}

resource "aws_ecs_task_definition" "service" {
  for_each = var.services

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = each.value.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = each.key
      image                  = each.value.image
      essential              = true
      readonlyRootFilesystem = true
      privileged             = false
      portMappings = each.value.container_port == null ? [] : [{
        containerPort = each.value.container_port
        protocol      = "tcp"
      }]
      environment = [for k, v in each.value.environment : { name = k, value = v }]
      secrets     = [for k, v in each.value.secret_references : { name = k, valueFrom = v }]
      stopTimeout = 120
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "service" {
  for_each = var.services

  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.service[each.key].arn
  desired_count                      = each.value.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = each.value.attach_to_alb ? 60 : null
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 150 # connection arithmetic in DEVOPS-PLAN 9.1 assumes 150 %

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service[each.key].id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.attach_to_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  tags = local.tags

  lifecycle {
    # Auto-scaling owns the count after creation; the pipeline holds it during a rollout.
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------------------
# Auto-scaling (floor 2, ceilings from the connection budget)
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "service" {
  for_each           = var.services
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.service[each.key].name}"
  min_capacity       = each.value.min_count
  max_capacity       = each.value.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = var.services
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = var.scale_in_cooldown_seconds
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "requests" {
  for_each           = local.alb_services
  name               = "${var.name}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 500 # placeholder; set from the load test
    scale_in_cooldown  = var.scale_in_cooldown_seconds
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.service[each.key].arn_suffix}"
    }
  }
}
