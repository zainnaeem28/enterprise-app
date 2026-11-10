# Names match infra/modules/ci-trust `refs` (restore_*): the approvals root passes these to the gh-restore-test policy.
output "restore_task_definition_arn" {
  description = "Revision-specific ARN of the pinned task definition (gh-restore-test may RunTask this ARN only)."
  value       = aws_ecs_task_definition.restore.arn
}

output "restore_passrole_arns" {
  description = "Roles gh-restore-test may pass, to ecs-tasks.amazonaws.com only."
  value       = [aws_iam_role.task.arn, aws_iam_role.execution.arn]
}

output "restore_subnet_group_arn" {
  value = aws_db_subnet_group.restore.arn
}

output "restore_kms_key_arn" {
  value = module.kms.key_arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.restore.name
}

output "task_subnet_ids" {
  value = aws_subnet.restore[*].id
}

output "task_security_group_id" {
  value = aws_security_group.task.id
}

output "target_security_group_id" {
  description = "Security group the restored instance must carry (start-restore.mjs --security-group)."
  value       = aws_security_group.target.id
}

output "db_subnet_group_name" {
  value = aws_db_subnet_group.restore.name
}

output "pinned_image" {
  description = "Image reference as pinned in the task definition."
  value       = local.image
}
