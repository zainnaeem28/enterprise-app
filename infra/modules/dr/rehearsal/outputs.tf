output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "database_endpoint" {
  description = "Endpoint of the restored synthetic database (for the rehearsal steps)."
  value       = aws_db_instance.restored.address
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "rehearsal_id" {
  value = var.rehearsal_id
}

output "expires_at" {
  value = var.expires_at
}
