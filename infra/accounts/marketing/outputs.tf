output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "data_subnet_ids" {
  value = module.network.data_subnet_ids
}

output "data_kms_key_arn" {
  value = module.kms_data.key_arn
}
