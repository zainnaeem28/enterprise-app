# ENV-DR: the synthetic recovery-Region rehearsal stack (DEVOPS-PLAN 3.5, 10.4, 10.5; ARCHITECTURE 9.4). Authored, not applied.
#
# Created from IaC in the STAGING account under the production SCP, restores a database from a cross-Region copy of the
# synthetic loadtest snapshot, and is DESTROYED afterwards by scripts/restore/dr-rehearsal.sh. It holds no PHI and is not the
# restore-test boundary (that is ../restore-boundary and the production account). It contains no deletion protection, no
# final snapshot and no backups, so `tofu destroy` leaves nothing behind. It measures the IaC apply and database restore
# legs; the full timed procedure (identity replica, anchors, DNS, smoke) is run by people from docs/runbooks/restore.md.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  tags = merge(var.tags, {
    Module      = "dr-rehearsal"
    Environment = "dr-rehearsal"
    Purpose     = "dr-rehearsal"
    RehearsalId = var.rehearsal_id
    ExpiresAt   = var.expires_at
    Synthetic   = "true"
  })
  snapshot_name = element(split(":", var.snapshot_arn), length(split(":", var.snapshot_arn)) - 1)
}

# The guard every other resource depends on: wrong account, wrong Region, wrong name or a non-synthetic snapshot stops the plan.
resource "terraform_data" "guard" {
  input = var.rehearsal_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "This is not the staging account. The DR rehearsal stack is created in staging only, never in production or log-archive."
    }
    precondition {
      condition     = data.aws_region.current.name == var.expected_region
      error_message = "This is not the recovery Region."
    }
    precondition {
      condition     = startswith(var.name, "dr-")
      error_message = "The stack name must start with dr-."
    }
    precondition {
      condition     = startswith(var.snapshot_arn, "arn:aws:rds:${var.expected_region}:${var.expected_account_id}:snapshot:") && strcontains(local.snapshot_name, "-synthetic-")
      error_message = "The snapshot must be a snapshot in this account and Region whose name contains -synthetic-. A copy of a production snapshot is never restored here."
    }
  }
}

module "network" {
  source = "../../network"

  name                     = var.name
  cidr_block               = var.vpc_cidr
  az_count                 = 2
  nat_per_az               = false
  flow_log_destination_arn = var.flow_log_destination_arn
  tags                     = local.tags

  depends_on = [terraform_data.guard]
}

module "kms" {
  source             = "../../kms"
  alias              = "${var.name}-data"
  description        = "DR rehearsal database storage (synthetic data); destroyed with the stack"
  service_principals = ["rds.amazonaws.com"]
  # The deletion window is the shortest the service allows: the stack is short-lived by design.
  deletion_window_in_days = 7
  tags                    = local.tags

  depends_on = [terraform_data.guard]
}

resource "aws_db_subnet_group" "this" {
  name        = "${var.name}-data"
  description = "DR rehearsal database subnets"
  subnet_ids  = module.network.data_subnet_ids
  tags        = local.tags
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name}-db-"
  description = "DR rehearsal database: no ingress until the rehearsal adds the recovery-Region service group; no egress"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

# Deliberate deviations, each because the stack is synthetic and must leave nothing behind after `tofu destroy`:
# no backups (AWS-0077), no deletion protection (AWS-0177: destroy must succeed unattended), no Performance Insights (AWS-0133).
#trivy:ignore:AWS-0077
#trivy:ignore:AWS-0133
#trivy:ignore:AWS-0177
resource "aws_db_instance" "restored" {
  identifier          = "${var.name}-${var.rehearsal_id}"
  snapshot_identifier = var.snapshot_arn
  instance_class      = var.db_instance_class
  storage_encrypted   = true
  kms_key_id          = module.kms.key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = false

  iam_database_authentication_enabled = false
  auto_minor_version_upgrade          = false
  copy_tags_to_snapshot               = false
  performance_insights_enabled        = false

  # Short-lived and synthetic: nothing to keep after destroy.
  backup_retention_period = 0
  skip_final_snapshot     = true
  deletion_protection     = false
  apply_immediately       = true

  tags = merge(local.tags, { Name = "${var.name}-${var.rehearsal_id}" })

  timeouts {
    create = "4h"
    delete = "1h"
  }

  depends_on = [terraform_data.guard]
}
