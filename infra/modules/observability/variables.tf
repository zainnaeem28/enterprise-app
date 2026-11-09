variable "name" {
  description = "Name prefix, for example ehr-production."
  type        = string
}

variable "region" {
  description = "Region the alarms and canaries live in. Passed in so the module needs no data source and can be planned offline."
  type        = string
}

variable "account_id" {
  description = "AWS account id of this environment (used in ARNs)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id is 12 digits."
  }
}

variable "enable_core" {
  description = "Create the application, database, queue, backup and canary alarms. Set false for a second instance in us-east-1 that only holds alarms whose metrics live there (CloudFront-scope WAF)."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "Customer-managed key for SNS topics, log groups and canary artifacts (from the kms module)."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

# --- Paging and ticket routing (D-29, C-18) ---------------------------------

variable "page_email_endpoints" {
  description = "Named on-call people who receive pages by SNS email until a rota and paging service are chosen (D-29). Empty creates the topic with no subscriber: alerting is then not delivered, and the module output says so."
  type        = list(string)
  default     = []
}

variable "ticket_email_endpoints" {
  description = "Recipients of ticket-severity alerts."
  type        = list(string)
  default     = []
}

variable "security_email_endpoints" {
  description = "Security contact(s) for security-severity alerts."
  type        = list(string)
  default     = []
}

variable "on_call_rota_named" {
  description = "True only when the owner has named a rota with response times (D-29 / C-18). Drives the availability-claim output; it does not change any alarm."
  type        = bool
  default     = false
}

variable "runbook_base" {
  description = "Repository-relative document that holds one anchor per runbook id (OPERATIONS-HANDOFF.md until the runbook set exists)."
  type        = string
  default     = "docs/runbooks/OPERATIONS-RUNBOOKS.md"
}

# --- What is monitored --------------------------------------------------------

variable "alb_arn_suffix" {
  description = "ALB arn_suffix (compute module output arn_suffix of aws_lb)."
  type        = string
  default     = ""
}

variable "target_group_arn_suffixes" {
  description = "Target group arn_suffix by service, for unhealthy-host alarms."
  type        = map(string)
  default     = {}
}

variable "ecs_cluster_name" {
  description = "ECS cluster whose deployment and migration-task events are alarmed. Empty watches the whole account and Region."
  type        = string
  default     = ""
}

variable "db_instance_identifier" {
  type    = string
  default = ""
}

variable "db_allocated_storage_gb" {
  description = "Allocated storage, to turn the 20 % free-space rule into bytes."
  type        = number
  default     = 100
}

variable "db_connection_budget" {
  description = "max_connections (proposed 600, DEVOPS-PLAN 12 item 13). Alarm at 70 %."
  type        = number
  default     = 600
}

variable "log_group_names" {
  description = "Application log groups that get the data-protection policy and the findings alarm (from the compute module)."
  type        = list(string)
  default     = []
}

variable "certificate_arns" {
  description = "ACM certificates watched for expiry (alarm below 21 days)."
  type        = map(string)
  default     = {}
}

variable "waf_web_acls" {
  description = "Web ACLs whose blocked-request rate is watched. CLOUDFRONT scope metrics exist only in us-east-1."
  type = map(object({
    scope = string
  }))
  default = {}
  validation {
    condition     = alltrue([for k, v in var.waf_web_acls : contains(["REGIONAL", "CLOUDFRONT"], v.scope)])
    error_message = "waf_web_acls scope is REGIONAL or CLOUDFRONT."
  }
}

variable "waf_blocked_requests_threshold" {
  description = "Blocked requests per 5 minutes that count as a spike. Placeholder until the load test and the first weeks of traffic."
  type        = number
  default     = 500
}

variable "backup_replication_rules" {
  description = "S3 replication rules that publish RTC metrics (bucket, destination bucket, rule id)."
  type = map(object({
    source_bucket      = string
    destination_bucket = string
    rule_id            = string
  }))
  default = {}
}

variable "recovery_region" {
  description = "Recovery Region the backup-lag Lambda reads replicated automated backups from."
  type        = string
  default     = ""
}

variable "backup_vault_name" {
  description = "AWS Backup vault whose completed-job metric proves a successful backup in the last 26 hours."
  type        = string
  default     = ""
}

variable "db_replicated_backup_arn_pattern" {
  description = "Resource pattern for rds:DescribeDBInstanceAutomatedBackups (the API does not support narrower resources); documented so the reviewer can see it is deliberate."
  type        = string
  default     = "*"
}

variable "integration_vendors" {
  description = "Vendors whose circuit state and failure rate are alarmed. criticality page or ticket (BR-33)."
  type = map(object({
    criticality = string
  }))
  default = {}
  validation {
    condition     = alltrue([for k, v in var.integration_vendors : contains(["page", "ticket"], v.criticality)])
    error_message = "integration_vendors criticality is page or ticket."
  }
}

variable "break_glass_role_arns" {
  description = "Break-glass roles; any assumption raises a security alert."
  type        = list(string)
  default     = []
}

variable "migration_task_family" {
  description = "ECS task definition family of the migration task; a non-zero exit pages the releasing engineer."
  type        = string
  default     = ""
}

variable "app_metric_namespace" {
  description = "Namespace of the application custom metrics (queue age, outbox, audit, scope drift, restore test). Emission is a requirement on the application tickets and is Unverified until staging."
  type        = string
  default     = "EHR/Application"
}

variable "outbox_age_threshold_seconds" {
  description = "Unsent outbox events older than this page. Placeholder (DEVOPS-PLAN 11.3 says 'threshold')."
  type        = number
  default     = 300
}

variable "monthly_budget_usd" {
  description = "Monthly cost plan of this account; null creates no budget. Alerts at 50/80/100 % (DEVOPS-PLAN 12). Not chosen here: the owner provides it (C-12)."
  type        = number
  default     = null
}

variable "extra_budgets" {
  description = "Extra cost budgets, for example SMS or video spend versus plan."
  type = map(object({
    limit_usd    = number
    cost_filters = map(list(string))
  }))
  default = {}
}

# --- Telemetry (ADOT sidecar) -------------------------------------------------

variable "adot_image" {
  description = "ADOT collector image pinned by digest (repo@sha256:...). Empty skips the container definition output."
  type        = string
  default     = ""
  validation {
    condition     = var.adot_image == "" || can(regex("@sha256:[0-9a-f]{64}$", var.adot_image))
    error_message = "adot_image must be pinned by digest."
  }
}

variable "trace_sample_ratio" {
  description = "Fraction of traces kept (head sampling). Placeholder pending cost data."
  type        = number
  default     = 0.1
  validation {
    condition     = var.trace_sample_ratio > 0 && var.trace_sample_ratio <= 1
    error_message = "trace_sample_ratio is in (0, 1]."
  }
}

variable "data_protection_managed_identifiers" {
  description = "AWS-managed data identifier names for the log data-protection policy. Unverified against the service until staging; the custom identifiers below are what the plan tests rely on."
  type        = list(string)
  default     = ["EmailAddress", "Ssn-US", "PhoneNumber-US", "Address", "Name"]
}

variable "findings_retention_days" {
  type    = number
  default = 90
}

# --- Synthetic checks ---------------------------------------------------------

variable "canary_artifacts_bucket" {
  description = "Existing bucket for canary artifacts (status codes and timings only). Empty creates no canaries."
  type        = string
  default     = ""
}

variable "canary_runtime_version" {
  description = "CloudWatch Synthetics runtime. Unverified: the current supported name is confirmed at apply in staging."
  type        = string
  default     = "syn-nodejs-puppeteer-9.1"
}

variable "canaries" {
  description = "Read-only canaries. kind shallow checks /healthz and TLS expiry; journey loads a PHI-free page. release_json_url, if set, is read so X-Client-Release is sent (AL-04)."
  type = map(object({
    url              = string
    kind             = string
    every_minutes    = number
    page_on_failure  = bool
    release_json_url = optional(string, "")
  }))
  default = {}
  validation {
    condition     = alltrue([for k, v in var.canaries : can(regex("^https://[a-z0-9.-]+(/[A-Za-z0-9_./-]*)?$", v.url))])
    error_message = "Canary URLs are https, have no query string and no credentials."
  }
  validation {
    condition     = alltrue([for k, v in var.canaries : contains([1, 5, 15], v.every_minutes)])
    error_message = "Canary frequency is 1, 5 or 15 minutes (DEVOPS-PLAN 11.4)."
  }
  validation {
    condition     = alltrue([for k, v in var.canaries : contains(["shallow", "journey"], v.kind)])
    error_message = "Canary kind is shallow or journey. Write canaries are a separate input and never run in production."
  }
}

variable "canary_min_cert_days" {
  type    = number
  default = 21
}

variable "canary_price_per_run_usd" {
  description = "US East price verified by the reviewer 2026-11-04 (DEVOPS-PLAN 11.4). Used only for the cost output."
  type        = number
  default     = 0.0012
}

# --- Thresholds the plan names without a number --------------------------------

variable "integration_failure_rate_threshold_pct" {
  description = "Vendor failure rate (percent over 5 minutes) above which the vendor alert fires (BR-33). Placeholder until vendors are chosen."
  type        = number
  default     = 25
}

variable "audit_anchor_late_threshold_seconds" {
  description = "Age of the newest audit anchor beyond which the anchor job is late. Anchors are written every minute (ARCHITECTURE 6); 300 s is five missed anchors. Placeholder until the Solution Architect confirms."
  type        = number
  default     = 300
}

variable "backup_replica_first_report_seen" {
  description = "False until the first cross-Region backup replica has reported (DEVOPS-PLAN 11.3: the lag alarm is inactive until then). Alarm actions are disabled while false."
  type        = bool
  default     = false
}

variable "app_metrics_heartbeat_enabled" {
  description = "Turn on the silent-emitter alarms. Leave false until the application publishes the metrics every period (zero when idle); otherwise they would alarm from the start."
  type        = bool
  default     = false
}
