# Production profile. Every value here must equal what the production account root
# passes to the same modules. It is a single reviewable block on purpose: the
# equivalence check (tests/load/harness/check-equivalence.mjs) compares it with the
# production plan, and `tests/plan.tftest.hcl` pins it.
#
# Differences from production, all justified (decision-log HEAAA-586 D-1):
#   - environment name, run id, hosts, certificates, keys, secrets (identity only);
#   - deletion_protection=false, force_destroy=true: the environment is torn down after every run;
#   - recovery_backup_replication_enabled=false and no backup copy vaults: synthetic data,
#     nothing to recover, and the log-archive vault must not receive loadtest recovery points;
#   - environment_class=non-production is NOT used: the loadtest runs the production code path
#     (HTTPS from ALB to task).
locals {
  profile = {
    az_count   = 3
    nat_per_az = true

    database = {
      engine_version           = "17"
      instance_class           = "db.r6i.xlarge"
      multi_az                 = true
      allocated_storage_gb     = 1000
      max_allocated_storage_gb = 4000
      backup_retention_days    = 35
    }

    services = {
      api = {
        cpu            = 2048
        memory         = 4096
        container_port = 8080
        attach_to_alb  = true
        desired_count  = 4
        min_count      = 2
        max_count      = 8
      }
      worker = {
        cpu            = 1024
        memory         = 2048
        container_port = null
        attach_to_alb  = false
        desired_count  = 2
        min_count      = 2
        max_count      = 4
      }
    }

    sse_heartbeat_seconds                  = 15
    alb_idle_timeout_seconds               = 60
    cloudfront_origin_read_timeout_seconds = 30
  }
}
