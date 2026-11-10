# Production audit-anchor archive (AWS-DO-1, HEAAA-709): the Object Lock bucket that the worker's anchor archive adapter
# writes to (EHR_S3_ANCHOR_ARCHIVE_BUCKET / _KMS_KEY_ID). Authored only, never applied. The bucket policy (archive module)
# admits the production worker role to anchors/* only: PutObject, GetObject, GetObjectVersion and a prefix-limited
# list; delete, retention and legal-hold actions are denied to everyone. Apply after the production root, because the
# bucket policy and the key policy name the worker role and AWS refuses principals that do not exist.

variable "recovery_region" {
  type    = string
  default = "us-west-2"
}

variable "archive_name_prefix" {
  description = "Prefix of the archive resources, for example ehr-logarchive (bucket <prefix>-audit-archive)."
  type        = string
}

variable "archive_retention_days" {
  description = "Object Lock default retention of the archive. OPEN (NFR-13, counsel): the longest legal minimum; deliberately no default. COMPLIANCE mode cannot be shortened once objects are written."
  type        = number
}

variable "anchor_writer_principal_arns" {
  description = "Production worker task role (production root output worker_task_role_arn)."
  type        = list(string)
}

variable "anchor_reader_principal_arns" {
  description = "Roles that verify anchors: the same worker role."
  type        = list(string)
}

variable "partition_writer_principal_arns" {
  description = "Audit archiver role(s) for partitions/* (a separate ticket; empty until it exists)."
  type        = list(string)
  default     = []
}

provider "aws" {
  alias  = "recovery"
  region = var.recovery_region
  assume_role { role_arn = var.apply_role_arn }
  default_tags { tags = local.tags }
}

module "archive_key" {
  source                     = "../../modules/kms"
  alias                      = "audit-archive"
  description                = "audit archive (anchors and partitions) and its backup vaults"
  multi_region               = true
  cross_account_decrypt_arns = concat(var.anchor_writer_principal_arns, var.anchor_reader_principal_arns, var.partition_writer_principal_arns)
  tags                       = local.tags
}

resource "aws_kms_replica_key" "archive_recovery" {
  provider        = aws.recovery
  description     = "audit archive (recovery Region replica)"
  primary_key_arn = module.archive_key.key_arn
  tags            = local.tags
}

module "archive" {
  source    = "../../modules/archive"
  providers = { aws = aws, aws.recovery = aws.recovery }

  name_prefix                  = var.archive_name_prefix
  organization_id              = var.organization_id
  kms_key_arn                  = module.archive_key.key_arn
  replica_kms_key_arn          = aws_kms_replica_key.archive_recovery.arn
  retention_days               = var.archive_retention_days
  anchor_writer_principal_arns = var.anchor_writer_principal_arns
  anchor_reader_principal_arns = var.anchor_reader_principal_arns
  writer_principal_arns        = var.partition_writer_principal_arns
  tags                         = local.tags
}

output "archive_bucket_name" {
  description = "Production input anchor_archive_bucket_name."
  value       = module.archive.archive_bucket_name
}

output "archive_key_arn" {
  description = "Production input anchor_archive_kms_key_arn."
  value       = module.archive_key.key_arn
}
