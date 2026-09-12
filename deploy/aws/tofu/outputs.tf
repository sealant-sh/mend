output "region" { value = var.region }
output "vpc_id" { value = aws_vpc.poc.id }
output "private_subnet_id" { value = aws_subnet.private.id }
output "public_subnet_id" { value = aws_subnet.public.id }
output "workload_sg_id" { value = aws_security_group.workload.id }

# FSx outputs are null when enable_fsx is false.
output "fsx_dns_name" { value = one(aws_fsx_openzfs_file_system.store[*].dns_name) }
output "fsx_file_system_id" { value = one(aws_fsx_openzfs_file_system.store[*].id) }
# OpenZFS mounts the root volume at /fsx; child volumes are exported under it.
output "fsx_mend_volume_path" {
  value = var.enable_fsx ? "/fsx/${one(aws_fsx_openzfs_volume.mend[*].name)}" : null
}

output "artifact_bucket" { value = aws_s3_bucket.artifacts.bucket }
output "ecr_workspace_repo" { value = aws_ecr_repository.workspace.repository_url }

output "microvm_build_role_arn" { value = aws_iam_role.microvm_build.arn }
output "microvm_exec_role_arn" { value = aws_iam_role.microvm_exec.arn }
output "connector_operator_role_arn" { value = aws_iam_role.connector_operator.arn }
output "bench_log_group" { value = aws_cloudwatch_log_group.microvm_bench.name }
output "vpc_egress_connector_arn" { value = aws_lambdacore_network_connector.vpc_egress.arn }
output "account_id" { value = data.aws_caller_identity.current.account_id }
