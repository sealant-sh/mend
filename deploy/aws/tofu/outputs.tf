output "account_id" { value = local.account_id }
output "region" { value = local.region }
output "vpc_id" { value = aws_vpc.poc.id }
output "vpc_cidr" { value = aws_vpc.poc.cidr_block }
output "public_subnet_ids" { value = { for az, subnet in aws_subnet.public : az => subnet.id } }
output "private_subnet_ids" { value = { for az, subnet in aws_subnet.private : az => subnet.id } }
output "private_route_table_ids" { value = { for az, route in aws_route_table.private : az => route.id } }
output "nat_public_ip" { value = aws_eip.nat.public_ip }
output "s3_gateway_endpoint_id" { value = aws_vpc_endpoint.s3.id }

output "eks_workload_sg_id" { value = one(aws_security_group.eks_workload[*].id) }
output "eks_cluster_sg_id" { value = one(aws_eks_cluster.poc[*].vpc_config[0].cluster_security_group_id) }
output "microvm_sg_id" { value = aws_security_group.microvm.id }
output "planetscale_sg_id" { value = aws_security_group.planetscale.id }
output "planetscale_endpoint_id" { value = aws_vpc_endpoint.planetscale.id }
output "planetscale_endpoint_dns_entries" { value = aws_vpc_endpoint.planetscale.dns_entry }
output "planetscale_private_dns" { value = "aws-eu-central-1-2.private-pg.psdb.cloud" }

output "capture_bucket" { value = aws_s3_bucket.captures.bucket }
output "capture_bucket_arn" { value = aws_s3_bucket.captures.arn }
output "capture_store_url" { value = "s3://${aws_s3_bucket.captures.bucket}" }
output "capture_s3_endpoint" { value = "https://s3.${local.region}.amazonaws.com" }
output "artifact_bucket" { value = aws_s3_bucket.artifacts.bucket }
output "artifact_bucket_arn" { value = aws_s3_bucket.artifacts.arn }
output "ecr_workspace_repo" { value = aws_ecr_repository.workspace.repository_url }
output "ecr_workspace_repo_arn" { value = aws_ecr_repository.workspace.arn }

output "microvm_build_role_arn" { value = aws_iam_role.microvm_build.arn }
output "microvm_exec_role_arn" { value = aws_iam_role.microvm_exec.arn }
output "connector_operator_role_arn" { value = aws_iam_role.connector_operator.arn }
output "microvm_build_log_group" { value = aws_cloudwatch_log_group.microvm_build.name }
output "microvm_exec_log_group" { value = aws_cloudwatch_log_group.microvm_exec.name }
output "vpc_egress_connector_arn" { value = aws_lambdacore_network_connector.vpc_egress.arn }

output "cluster_name" { value = one(aws_eks_cluster.poc[*].name) }
output "cluster_arn" { value = one(aws_eks_cluster.poc[*].arn) }
output "cluster_endpoint" { value = one(aws_eks_cluster.poc[*].endpoint) }
output "cluster_certificate_authority_data" { value = one(aws_eks_cluster.poc[*].certificate_authority[0].data) }
output "kubernetes_version" { value = one(aws_eks_cluster.poc[*].version) }
output "node_group_name" { value = one(aws_eks_node_group.poc[*].node_group_name) }
output "eks_role_arn" { value = one(aws_iam_role.eks[*].arn) }
output "node_role_arn" { value = one(aws_iam_role.node[*].arn) }
output "cni_role_arn" { value = one(aws_iam_role.cni[*].arn) }
output "ebs_csi_role_arn" { value = one(aws_iam_role.ebs_csi[*].arn) }
output "oidc_provider_arn" { value = one(aws_iam_openid_connect_provider.eks[*].arn) }
output "oidc_provider_url" { value = one(aws_iam_openid_connect_provider.eks[*].url) }
output "oidc_issuer_hostpath" { value = local.oidc_issuer }
output "kubeconfig_command" {
  description = "Run after a separately approved apply, as the cluster-creating principal and from an allowed CIDR."
  value       = var.cluster_enabled ? "aws eks update-kubeconfig --region ${local.region} --name ${aws_eks_cluster.poc[0].name}" : null
}
output "budget_name" { value = aws_budgets_budget.poc.name }
