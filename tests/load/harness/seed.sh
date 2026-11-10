#!/usr/bin/env bash
# Run the synthetic-data generator once inside the loadtest environment and wait for it.
# Input: `terraform output -json seeder_run_task` file. Seed and counts are baked into the
# task definition (recorded with the run). No production or staging data is ever read.
set -euo pipefail
spec="${1:?usage: seed.sh <seeder_run_task.json>}"
jqv() { jq -r "(.value // .) | $1" "$spec"; }
td=$(jqv .task_definition); subnets=$(jqv '.subnets|join(",")'); sgs=$(jqv '.security_groups|join(",")'); cluster=$(jqv .cluster)
arn=$(aws ecs run-task --cluster "$cluster" --launch-type FARGATE --task-definition "$td" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sgs],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
echo "seeder task: $arn"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn"
code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)
[ "$code" = "0" ] || { echo "seeder exited with $code" >&2; exit 1; }
