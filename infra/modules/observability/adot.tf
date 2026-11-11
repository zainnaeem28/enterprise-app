# OpenTelemetry (DEVOPS-PLAN 11.1): ADOT collector as a sidecar -> CloudWatch (X-Ray traces, EMF metrics).
# Logs are not sent through OTLP: the services write structured JSON to stdout (awslogs driver) with the logger allowlist.
# The collector config drops every attribute key not on the allowlist and blocks PHI-shaped values (second line of defence).
# Wiring the sidecar into the task definition is the compute module's change (outputs below); this module does not edit it.
# Unverified until the staging image test: that the pinned ADOT image includes the redaction and probabilistic sampler components.

locals {
  allowed_keys = jsondecode(file("${path.module}/adot/allowed-attributes.json")).allowed_keys

  blocked_value_patterns = [
    local.canary_regex,
    "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    "\\b[0-9]{3}-[0-9]{2}-[0-9]{4}\\b",
    "\\b(?:\\+?1[ -.]?)?\\(?[0-9]{3}\\)?[ -.][0-9]{3}[ -.][0-9]{4}\\b",
    "\\b(?:[0-9][ -]?){13,19}\\b",
    "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
    "[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}",
    "(?i)(dob|date_of_birth|birth_date)\\W{1,3}(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}",
  ]

  # Attributes that instrumentation libraries add by default and that can hold identifiers, query strings or SQL text.
  deleted_keys = [
    "http.url", "url.full", "url.query", "url.path", "http.target", "http.request.header.cookie", "http.request.header.authorization",
    "http.response.header.set-cookie", "db.statement", "db.query.text", "db.connection_string", "enduser.id", "user.id", "user.email",
    "client.address", "net.peer.ip", "http.client_ip", "http.user_agent", "user_agent.original",
  ]

  collector_config = {
    extensions = {
      health_check = { endpoint = "127.0.0.1:13133" }
    }
    receivers = {
      otlp = { protocols = { http = { endpoint = "127.0.0.1:4318" } } }
    }
    processors = {
      memory_limiter = { check_interval = "1s", limit_mib = 100, spike_limit_mib = 25 }
      "attributes/drop" = {
        actions = [for k in local.deleted_keys : { key = k, action = "delete" }]
      }
      redaction = {
        allow_all_keys       = false
        allowed_keys         = local.allowed_keys
        blocked_key_patterns = [".*(token|secret|password|authorization|cookie|ssn|dob|birth|email|phone).*"]
        blocked_values       = local.blocked_value_patterns
        summary              = "info"
      }
      probabilistic_sampler = { sampling_percentage = var.trace_sample_ratio * 100 }
      batch                 = { timeout = "5s" }
    }
    exporters = {
      awsxray = { region = var.region }
      awsemf = {
        region         = var.region
        namespace      = "${var.name}/Telemetry"
        log_group_name = "/${var.name}/otel-emf"
      }
    }
    service = {
      extensions = ["health_check"]
      telemetry  = { logs = { level = "warn" } }
      pipelines = {
        traces  = { receivers = ["otlp"], processors = ["memory_limiter", "attributes/drop", "redaction", "probabilistic_sampler", "batch"], exporters = ["awsxray"] }
        metrics = { receivers = ["otlp"], processors = ["memory_limiter", "attributes/drop", "redaction", "batch"], exporters = ["awsemf"] }
      }
    }
  }
  collector_yaml = yamlencode(local.collector_config)
}

resource "aws_cloudwatch_log_group" "adot" {
  # checkov:skip=CKV_AWS_338:Log retention is var.log_retention_days (90 days, owner ruling C item 2, counsel confirmation pending); the 1-year archive stage is described in infra/RETENTION.md
  count             = var.enable_core ? 1 : 0
  name              = "/${var.name}/adot-collector"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "emf" {
  # checkov:skip=CKV_AWS_338:Log retention is var.log_retention_days (90 days, owner ruling C item 2, counsel confirmation pending); the 1-year archive stage is described in infra/RETENTION.md
  count             = var.enable_core ? 1 : 0
  name              = "/${var.name}/otel-emf"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

# The collector configuration is not secret; it is kept encrypted in Parameter Store so the task definition references it by ARN.
# The task execution role needs ssm:GetParameters on it and kms:Decrypt on kms_key_arn (identity module).
resource "aws_ssm_parameter" "collector_config" {
  count  = var.enable_core ? 1 : 0
  name   = "/${var.name}/observability/adot-collector-config"
  type   = "SecureString"
  key_id = var.kms_key_arn
  tier   = length(local.collector_yaml) > 4000 ? "Advanced" : "Standard"
  value  = local.collector_yaml
  tags   = var.tags
}
