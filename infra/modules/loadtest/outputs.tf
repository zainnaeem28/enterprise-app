output "environment" {
  value = {
    name       = local.env_name
    run_id     = var.run_id
    expires_at = var.expires_at
  }
}

output "alb_dns_name" {
  description = "Direct ALB name (integrations host path)."
  value       = module.compute.alb_dns_name
}

output "cluster_name" {
  value = module.compute.cluster_name
}

output "seeder_run_task" {
  description = "Everything `aws ecs run-task` needs for the seeder."
  value = {
    cluster         = module.compute.cluster_name
    task_definition = aws_ecs_task_definition.seeder.arn
    subnets         = module.network.private_subnet_ids
    security_groups = [module.compute.service_security_group_ids["api"]]
  }
}

output "profile" {
  description = "Effective production profile, compared by the equivalence check."
  value       = local.profile
}

output "teardown_tag" {
  description = "Tag the reaper and cost guard select on."
  value       = { key = "RunId", value = var.run_id }
}
