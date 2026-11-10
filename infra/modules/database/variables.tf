variable "name_prefix" {
  description = "Prefix for resource names, for example ehr-prod."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  description = "Subnets with no internet route for the database (network module data_subnet_ids). At least two Availability Zones."
  type        = list(string)
  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "At least two data subnets in different Availability Zones are required."
  }
}

variable "client_security_group_ids" {
  description = "Security groups (api, worker, migration task) allowed to connect on 5432. Nothing else can reach the database."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Customer-managed key (primary Region) for storage, Performance Insights, the RDS-managed master secret and the local backup vault."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL major.minor. Major version 17 is required (SHARED-BOUNDARIES 12: transaction_timeout)."
  type        = string
  default     = "17"
  validation {
    condition     = can(regex("^17(\\.[0-9]+)?$", var.engine_version))
    error_message = "engine_version must be 17 or 17.x."
  }
}

variable "instance_class" {
  description = "Production start: 4 vCPU / 32 GB (ARCHITECTURE 9.3); resize after the load test."
  type        = string
  default     = "db.r6i.xlarge"
}

variable "multi_az" {
  description = "Multi-AZ standby. True for production; staging is single-AZ (DEVOPS-PLAN 3.2)."
  type        = bool
  default     = true
}

variable "allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 4000
}

variable "db_name" {
  type    = string
  default = "ehr"
}

variable "master_username" {
  description = "Administrative user used only by the bootstrap and break-glass procedures. Its password is created and rotated by RDS in Secrets Manager. It is not an application credential and appears in no application configuration or task definition."
  type        = string
  default     = "rds_master"
  validation {
    condition     = !contains(["postgres", "admin", "root"], var.master_username)
    error_message = "Use a non-default master user name."
  }
}

variable "backup_retention_days" {
  description = "Automated backup (point-in-time) retention; 35 is the service maximum (DEVOPS-PLAN 10.1)."
  type        = number
  default     = 35
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 7 to 35."
  }
}

variable "backup_window" {
  type    = string
  default = "05:00-06:00"
}

variable "maintenance_window" {
  type    = string
  default = "sun:07:00-sun:08:00"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "transaction_timeout_ms" {
  description = "Instance-level default for transaction_timeout, in milliseconds. 0 means no instance-wide limit so migrations and backfills are not cut off; the 60 s bound is carried by the audit-writing login roles (role_level_settings output, applied by the F-03 roles bootstrap). UNVERIFIED (C-01): that RDS PostgreSQL 17 exposes this parameter and that role-level values are readable from the audit insert trigger; proven in staging with verification/transaction_timeout_probe.sql."
  type        = number
  default     = 0
}

variable "recovery_backup_replication_enabled" {
  description = "Replicate automated backups (with logs) to the recovery Region (ARCHITECTURE 9.4)."
  type        = bool
  default     = true
}

variable "recovery_kms_key_arn" {
  description = "Key in the recovery Region that encrypts the replicated backups. Required when recovery_backup_replication_enabled."
  type        = string
  default     = null
  validation {
    condition     = !var.recovery_backup_replication_enabled || var.recovery_kms_key_arn != null
    error_message = "recovery_kms_key_arn is required when recovery_backup_replication_enabled is true."
  }
}

variable "backup_copy_vault_arns" {
  description = "Vault-locked vaults in the log-archive account (archive module outputs backup_vault_arn and recovery_backup_vault_arn) that receive each AWS Backup copy. Empty disables the AWS Backup plan."
  type        = list(string)
  default     = []
}

variable "monthly_retention_days" {
  description = "Monthly AWS Backup points are kept 12 months (DEVOPS-PLAN 10.1). Longer holds for legal reasons are a counsel decision."
  type        = number
  default     = 365
}

variable "copy_vault_min_retention_days" {
  description = "Vault lock minimum of the log-archive vaults (archive module vault_min_retention_days). Backup copy retention below this is rejected by AWS Backup."
  type        = number
  default     = 35
}

variable "copy_vault_max_retention_days" {
  description = "Vault lock maximum of the log-archive vaults (archive module vault_max_retention_days)."
  type        = number
  default     = 400
}

variable "tags" {
  type    = map(string)
  default = {}
}
