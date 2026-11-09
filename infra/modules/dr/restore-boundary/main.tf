# The `restore-test` boundary (DEVOPS-PLAN 3.5, 7.5, 10.3; DPR-11, DPR-17). Authored, not applied.
#
# Applied ONLY by the human-run approvals root, never by a workflow: the subnet group, security groups, KMS key, task
# definition (pinned digest) and endpoint policies are what `gh-restore-test` is allowed to USE and cannot change. The
# VPC has no internet gateway, NAT, peering or transit route, and nothing in the route tables except the local route and
# the S3 gateway endpoint. The only way out is VPC endpoints whose policies name the restore resources.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  region     = data.aws_region.current.name
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)
  tags       = merge(var.tags, { Module = "dr-restore-boundary", Boundary = "restore-test" })

  result_objects   = "arn:aws:s3:::${var.result_bucket_name}/restore-test/results/*"
  baseline_objects = "arn:aws:s3:::${var.result_bucket_name}/restore-test/baseline/*"
  # ECR serves image layers from an AWS-owned bucket; the gateway endpoint must allow it or pulls fail (Unverified name pattern).
  ecr_layer_objects = "arn:aws:s3:::prod-${local.region}-starport-layer-bucket/*"
  image             = "${var.image_repository_url}@${var.image_digest}"
}

# ---------------------------------------------------------------------------
# Network: private subnets, local route only
# ---------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-default-deny" })
}

resource "aws_flow_log" "this" {
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "s3"
  log_destination          = var.flow_log_destination_arn
  max_aggregation_interval = 60
  tags                     = merge(local.tags, { Name = "${var.name}-flow-log" })
}

resource "aws_subnet" "restore" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 1, count.index)

  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-${local.azs[count.index]}", Tier = "restore" })
}

# No route other than local (added by AWS) and the S3 gateway endpoint (below).
resource "aws_route_table" "restore" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-local-only" })
}

resource "aws_route_table_association" "restore" {
  count          = 2
  subnet_id      = aws_subnet.restore[count.index].id
  route_table_id = aws_route_table.restore.id
}

resource "aws_db_subnet_group" "restore" {
  name        = "${var.name}-targets"
  description = "Restore targets live here and nowhere else; the subnets have no internet route"
  subnet_ids  = aws_subnet.restore[*].id
  tags        = merge(local.tags, { Name = "${var.name}-targets" })
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "task" {
  name_prefix = "${var.name}-task-"
  description = "Restore check task: to the restored database and the endpoints only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-task" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "target" {
  name_prefix = "${var.name}-target-"
  description = "Restored database: PostgreSQL from the restore check task only; no egress"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-target" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name}-endpoints-"
  description = "Interface endpoints: HTTPS from the restore check task only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-endpoints" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "target_from_task" {
  security_group_id            = aws_security_group.target.id
  description                  = "PostgreSQL from the restore check task"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.task.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_target" {
  security_group_id            = aws_security_group.task.id
  description                  = "PostgreSQL to the restored database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.target.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_endpoints" {
  security_group_id            = aws_security_group.task.id
  description                  = "HTTPS to the interface endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_s3" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS to the S3 gateway endpoint prefix list (image layers, result documents)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_task" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from the restore check task"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.task.id
}

# ---------------------------------------------------------------------------
# Endpoints and their policies (the only egress)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid       = "ResultsAndBaselineOnly"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = [local.result_objects, local.baseline_objects]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
  statement {
    sid       = "ImageLayers"
    actions   = ["s3:GetObject"]
    resources = [local.ecr_layer_objects]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.restore.id]
  policy            = data.aws_iam_policy_document.s3_endpoint.json
  tags              = merge(local.tags, { Name = "${var.name}-s3" })
}

data "aws_iam_policy_document" "endpoint" {
  for_each = {
    "ecr-api" = { actions = ["ecr:GetAuthorizationToken"], resources = ["*"] }
    "ecr-dkr" = { actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], resources = [var.ecr_repository_arn] }
    "logs"    = { actions = ["logs:CreateLogStream", "logs:PutLogEvents"], resources = ["${aws_cloudwatch_log_group.task.arn}:*"] }
    "rds"     = { actions = ["rds:DescribeDBInstances", "rds:ModifyDBInstance"], resources = ["arn:aws:rds:${local.region}:${local.account_id}:db:rt-*"] }
    "sts"     = { actions = ["sts:GetCallerIdentity"], resources = ["*"] }
    "kms"     = { actions = ["kms:GenerateDataKey", "kms:Decrypt"], resources = [var.result_bucket_kms_key_arn] }
  }
  statement {
    sid       = "Named"
    actions   = each.value.actions
    resources = each.value.resources
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.task.arn, aws_iam_role.execution.arn]
    }
  }
}

locals {
  endpoint_services = {
    "ecr-api" = "ecr.api"
    "ecr-dkr" = "ecr.dkr"
    "logs"    = "logs"
    "rds"     = "rds"
    "sts"     = "sts"
    "kms"     = "kms"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.endpoint_services
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.restore[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  policy              = data.aws_iam_policy_document.endpoint[each.key].json
  tags                = merge(local.tags, { Name = "${var.name}-${each.key}" })
}

# ---------------------------------------------------------------------------
# Key for the restored instance (production data is re-encrypted into this key; destroyed with the boundary, never by a workflow)
# ---------------------------------------------------------------------------

module "kms" {
  source             = "../../kms"
  alias              = "${var.name}-targets"
  description        = "restore-test targets (RDS storage); gh-restore-test may use it through RDS only (its own policy, ci-trust)"
  service_principals = ["rds.amazonaws.com"]
  tags               = local.tags
}

# ---------------------------------------------------------------------------
# Task: cluster, log group, roles, pinned task definition
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "restore" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

# The log group holds counts and codes only (the result schema allows nothing else) and is encrypted at rest by CloudWatch.
# A customer-managed key would need a logs-service statement the shared kms module does not offer.
#trivy:ignore:AWS-0017
resource "aws_cloudwatch_log_group" "task" {
  name              = "/${var.name}/check"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "PullThePinnedRepositoryOnly"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [var.ecr_repository_arn]
  }
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "WriteTheTaskLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.task.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "pull-and-log"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "FindTheTarget"
    actions   = ["rds:DescribeDBInstances"]
    resources = ["arn:aws:rds:${local.region}:${local.account_id}:db:rt-*"]
  }
  statement {
    sid       = "ResetCredentialsOfRestoreTargetsOnly"
    actions   = ["rds:ModifyDBInstance"]
    resources = ["arn:aws:rds:${local.region}:${local.account_id}:db:rt-*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["restore-test"]
    }
  }
  statement {
    sid       = "WriteResultsReadBaseline"
    actions   = ["s3:PutObject"]
    resources = [local.result_objects]
  }
  statement {
    sid       = "ReadBaseline"
    actions   = ["s3:GetObject"]
    resources = [local.baseline_objects]
  }
  statement {
    sid       = "ResultBucketKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.result_bucket_kms_key_arn]
  }
  statement {
    sid       = "NothingElse"
    effect    = "Deny"
    actions   = ["iam:*", "secretsmanager:*", "ssm:*", "ecs:RegisterTaskDefinition", "ec2:AuthorizeSecurityGroup*", "ec2:ModifyVpcEndpoint", "rds:DeleteDBInstance", "rds:Restore*", "rds:CreateDBSnapshot"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "check-restored-target"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_ecs_task_definition" "restore" {
  family                   = "${var.name}-check"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # Fixed entry point, no arguments (DPR-28): RunTask overrides cannot change an entry point, and the workflow passes none.
  # Only non-secret configuration: nothing here lets the task reach anything but the endpoints above.
  container_definitions = jsonencode([
    {
      name                   = "restore-check"
      image                  = local.image
      essential              = true
      readonlyRootFilesystem = true
      privileged             = false
      user                   = "node"
      entryPoint             = ["node", "scripts/restore/task/restore-check.mjs"]
      environment = [
        { name = "AWS_REGION", value = local.region },
        { name = "RESTORE_RESULT_BUCKET", value = var.result_bucket_name },
        { name = "RESTORE_IMAGE_DIGEST", value = var.image_digest },
        { name = "RDS_CA_BUNDLE", value = var.rds_ca_bundle_path },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.task.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "check"
        }
      }
    }
  ])

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Detection: every restore API call is reported, so one outside the monthly window is noticed (10.3 step 2)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "restore_calls" {
  name        = "${var.name}-restore-api-calls"
  description = "Any RDS restore or RunTask of the pinned restore task definition. Expected once a month; anything else is looked at."
  event_pattern = jsonencode({
    source        = ["aws.rds", "aws.ecs"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventName = ["RestoreDBInstanceToPointInTime", "RestoreDBInstanceFromDBSnapshot", "RestoreDBInstanceFromS3", "RunTask"]
    }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "restore_calls" {
  count = var.alert_topic_arn == null ? 0 : 1
  rule  = aws_cloudwatch_event_rule.restore_calls.name
  arn   = var.alert_topic_arn
}
