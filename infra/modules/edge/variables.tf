variable "name" {
  description = "Name prefix, for example hea-staging."
  type        = string
}

variable "portals" {
  description = "PHI portals, one distribution and one bucket each. Keys are fixed."
  type = map(object({
    host = string
  }))
  validation {
    condition     = toset(keys(var.portals)) == toset(["patient", "staff", "pharmacy"])
    error_message = "portals must have exactly the keys patient, staff and pharmacy (my., staff., pharmacy.)."
  }
}

variable "integrations_host" {
  description = "Machine-client host. Not behind CloudFront (DEVOPS-PLAN 3.2, 'no CDN'); protected by the regional WAF on the ALB."
  type        = string
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate in us-east-1 covering the three portal hosts."
  type        = string
}

variable "alb_arn" {
  type = string
}

variable "alb_dns_name" {
  type = string
}

variable "origin_verify_header_name" {
  type    = string
  default = "X-Origin-Verify"
}

variable "origin_verify_secret" {
  description = "Same value as the compute module. Sensitive; held in state; never commit a value."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.origin_verify_secret) >= 32
    error_message = "origin_verify_secret must be at least 32 characters."
  }
}

variable "origin_read_timeout_seconds" {
  description = "CloudFront origin read timeout for /api/*. 30 s is the default; the API sends an SSE heartbeat every 15 s (ARCHITECTURE 5.4). Raising it above 60 needs a quota request."
  type        = number
  default     = 30
  validation {
    condition     = var.origin_read_timeout_seconds >= 30 && var.origin_read_timeout_seconds <= 60
    error_message = "Between 30 and 60 seconds (above 60 needs a quota increase)."
  }
}

variable "cloudfront_logs_bucket_domain" {
  description = "Bucket domain name (log-archive) for CloudFront standard logs, e.g. logs.s3.amazonaws.com. The bucket must allow CloudFront log delivery."
  type        = string
}

variable "waf_log_group_arn_cloudfront" {
  description = "CloudWatch log group (name starts aws-waf-logs-) in us-east-1 for the CloudFront web ACL."
  type        = string
}

variable "waf_log_group_arn_regional" {
  description = "CloudWatch log group (name starts aws-waf-logs-) in the ALB Region for the regional web ACL."
  type        = string
}

variable "content_security_policy" {
  description = "CSP sent by the portal distributions. Default blocks framing, third-party scripts and analytics hosts (BR-36); the front-end lane confirms it against the real bundle (Unverified)."
  type        = string
  default     = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
}

variable "entry_ttl_seconds" {
  description = "Entry document TTL (DEVOPS-PLAN 6.2: 60 s)."
  type        = number
  default     = 60
}

variable "rate_limit_general_per_5min" {
  description = "Per-IP request limit over 5 minutes on portal distributions. Proposed placeholder."
  type        = number
  default     = 2000
}

variable "rate_limit_auth_per_5min" {
  description = "Per-IP limit on /api/v1/auth*. Proposed placeholder."
  type        = number
  default     = 100
}

variable "rate_limit_public_per_5min" {
  description = "Per-IP limit on integrations /public/v1/*. Proposed placeholder."
  type        = number
  default     = 300
}

variable "rate_limit_integrations_per_5min" {
  description = "Per-IP limit on the rest of the integrations host. Proposed placeholder."
  type        = number
  default     = 1000
}

variable "bot_control_paths" {
  description = "Public-form paths that get AWS Bot Control (NFR-17). Empty means Bot Control is not created: it is a paid rule group and the paths are not yet defined."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for p in var.bot_control_paths : can(regex("^/[A-Za-z0-9/_-]+$", p))])
    error_message = "Paths must be plain absolute paths."
  }
}

variable "noncurrent_version_days" {
  description = "Days to keep non-current objects in the portal buckets (assets are kept 90 days, DEVOPS-PLAN 6.2)."
  type        = number
  default     = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
