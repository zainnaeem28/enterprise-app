variable "name" {
  description = "Name prefix, for example hea-staging."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  description = "Private subnets (at least two AZs) for the internal ALB and the Fargate tasks."
  type        = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Tasks must span at least two AZs (DEVOPS-PLAN 3.2)."
  }
}

variable "kms_key_arn" {
  description = "Key for log groups (logs key from the kms module)."
  type        = string
}

variable "alb_certificate_arn" {
  description = "ACM certificate for the ALB. Its names must cover every portal host and the integrations host, because CloudFront forwards the viewer Host header."
  type        = string
}

variable "portal_hosts" {
  description = "Host names served through CloudFront (patient, staff, pharmacy portals)."
  type        = list(string)
  validation {
    condition     = length(var.portal_hosts) > 0
    error_message = "At least one portal host is required."
  }
}

variable "integrations_host" {
  description = "Machine-client host. Served through its own CloudFront distribution (edge module) to the same internal ALB; no cookies."
  type        = string
}

variable "origin_verify_header_name" {
  type    = string
  default = "X-Origin-Verify"
}

variable "origin_verify_secret" {
  description = "Shared value CloudFront adds to origin requests; every forwarding rule (portal and integrations hosts) requires it, so requests without it get 403 at the ALB. Defence in depth behind the VPC-origin network path. Supplied from the secret store by the pipeline; it is held in state, so rotate it as a secret. Never commit a value."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.origin_verify_secret) >= 32
    error_message = "origin_verify_secret must be at least 32 characters."
  }
}

variable "access_logs_bucket" {
  description = "S3 bucket (log-archive) for ALB access logs. Its policy must allow the regional ELB log delivery principal."
  type        = string
}

variable "access_logs_prefix" {
  type    = string
  default = "alb"
}

variable "alb_idle_timeout_seconds" {
  type    = number
  default = 60
}

variable "sse_heartbeat_seconds" {
  description = "API SSE heartbeat (ARCHITECTURE 5.4: 15 s). Must stay below the ALB idle timeout and the CloudFront origin read timeout."
  type        = number
  default     = 15
}

variable "cloudfront_origin_read_timeout_seconds" {
  description = "Value the edge module sets; passed here only so the heartbeat relationship is checked in one place."
  type        = number
  default     = 30
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "log_retention_days" {
  description = "Application log group retention: 90 days, then the archive keeps 1 year (owner ruling C item 2 †, counsel confirmation pending; infra/RETENTION.md)."
  type        = number
  default     = 90
  validation {
    condition     = var.log_retention_days >= 90
    error_message = "log_retention_days must be at least 90."
  }
}

variable "container_insights" {
  type    = bool
  default = true
}

variable "deregistration_delay_seconds" {
  description = "Long enough to drain SSE streams; clients reconnect with Last-Event-ID."
  type        = number
  default     = 120
}

variable "database_security_group_ids" {
  description = "Database security groups the tasks may reach on database_port. The matching ingress rule belongs to the database module."
  type        = list(string)
  default     = []
}

variable "database_port" {
  type    = number
  default = 5432
}

variable "execution_role_arn" {
  description = "Task execution role (pull image, write logs, read secret references). Created by the identity ticket."
  type        = string
}

variable "services" {
  description = "ECS services. Images must be pinned by digest (build once, promote the same digest)."
  type = map(object({
    image             = string
    task_role_arn     = string
    cpu               = number
    memory            = number
    container_port    = optional(number)
    backend_protocol  = optional(string, "HTTPS")
    attach_to_alb     = bool
    desired_count     = number
    min_count         = number
    max_count         = number
    environment       = optional(map(string), {})
    secret_references = optional(map(string), {})
  }))

  validation {
    condition     = alltrue([for k in keys(var.services) : contains(["api", "worker"], k)])
    error_message = "Services are api and worker."
  }
  validation {
    condition     = alltrue([for s in values(var.services) : can(regex("@sha256:[0-9a-f]{64}$", s.image))])
    error_message = "Images must be referenced by sha256 digest."
  }
  validation {
    condition     = alltrue([for k, s in var.services : s.min_count >= 2 && s.min_count <= s.desired_count && s.desired_count <= s.max_count])
    error_message = "Floor is 2 tasks; min <= desired <= max."
  }
  validation {
    condition     = alltrue([for k, s in var.services : k != "api" || s.max_count <= 8]) && alltrue([for k, s in var.services : k != "worker" || s.max_count <= 4])
    error_message = "Task ceilings come from the database connection budget: api <= 8, worker <= 4 (DEVOPS-PLAN 12)."
  }
  validation {
    condition     = alltrue([for s in values(var.services) : s.backend_protocol == "HTTPS" || (var.plaintext_backend_exception_ref != "" && var.environment_class != "production")])
    error_message = "backend_protocol HTTP is allowed only outside production and only with plaintext_backend_exception_ref (written Solution Architect/Security exception). Default is HTTPS."
  }
  validation {
    condition     = alltrue([for k, s in var.services : !s.attach_to_alb || s.container_port != null])
    error_message = "A service attached to the ALB needs container_port."
  }
}

variable "scale_in_cooldown_seconds" {
  description = "Long cooldown to protect SSE streams on scale-in."
  type        = number
  default     = 600
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "plaintext_backend_exception_ref" {
  description = "Reference (task/document id) of a written Solution Architect/Security exception that allows a plaintext ALB-to-task hop. Empty means HTTPS only."
  type        = string
  default     = ""
}

variable "environment_class" {
  description = "production or non-production. Plaintext backend is never allowed in production."
  type        = string
  default     = "production"
  validation {
    condition     = contains(["production", "non-production"], var.environment_class)
    error_message = "environment_class is production or non-production."
  }
}
