data "aws_iam_policy_document" "eks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks" {
  name               = "${local.name}-eks"
  assume_role_policy = data.aws_iam_policy_document.eks_trust.json
}

resource "aws_iam_role_policy_attachment" "eks" {
  role       = aws_iam_role.eks.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = 14
}

resource "aws_eks_cluster" "poc" {
  name                          = local.name
  role_arn                      = aws_iam_role.eks.arn
  version                       = var.kubernetes_version
  bootstrap_self_managed_addons = false
  enabled_cluster_log_types     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  upgrade_policy {
    support_type = "STANDARD"
  }

  vpc_config {
    subnet_ids              = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids      = [aws_security_group.eks_workload.id]
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.operator_cidrs
  }

  depends_on = [aws_iam_role_policy_attachment.eks, aws_cloudwatch_log_group.eks]
}

resource "aws_iam_openid_connect_provider" "eks" {
  url            = aws_eks_cluster.poc.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]
  # IAM retrieves the thumbprint and verifies the issuer through its trusted CA list.
}

locals {
  oidc_issuer = replace(aws_iam_openid_connect_provider.eks.url, "https://", "")
}

data "aws_iam_policy_document" "node_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${local.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_trust.json
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset(["AmazonEKSWorkerNodePolicy", "AmazonEC2ContainerRegistryPullOnly"])

  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}

resource "aws_launch_template" "node" {
  name                   = "${local.name}-node"
  vpc_security_group_ids = [aws_security_group.eks_workload.id]
  update_default_version = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_type           = "gp3"
      volume_size           = 40
      encrypted             = true
      delete_on_termination = true
    }
  }

  dynamic "tag_specifications" {
    for_each = toset(["instance", "volume", "network-interface"])
    content {
      resource_type = tag_specifications.value
      tags = {
        Name           = "${local.name}-node"
        project        = "mend"
        environment    = "aws-capture-poc"
        "mend-cluster" = local.name
      }
    }
  }
}

resource "aws_eks_node_group" "poc" {
  cluster_name    = aws_eks_cluster.poc.name
  node_group_name = "control-plane-workloads"
  node_role_arn   = aws_iam_role.node.arn
  # Keep single-node replacements in the same AZ as NAT and future gp3 PVCs.
  # The EKS control plane and both endpoints still span both private subnets.
  subnet_ids      = [aws_subnet.private["${local.region}${var.az_suffixes[0]}"].id]
  ami_type        = "AL2023_ARM_64_STANDARD"
  capacity_type   = "ON_DEMAND"
  instance_types  = ["m7g.large"]
  version         = var.kubernetes_version
  release_version = var.node_release_version

  scaling_config {
    desired_size = 1
    min_size     = 1
    max_size     = 1
  }

  # MINIMAL avoids temporary surge nodes, at the cost of downtime on replacement.
  update_config {
    max_unavailable = 1
    update_strategy = "MINIMAL"
  }

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  depends_on = [
    aws_iam_role_policy_attachment.node,
    aws_eks_addon.vpc_cni,
    aws_route_table_association.private,
    aws_vpc_security_group_ingress_rule.eks_internal,
    aws_vpc_security_group_egress_rule.eks,
  ]
}

# CNI permissions do not belong on the EC2 node role either.
data "aws_iam_policy_document" "cni_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:kube-system:aws-node"]
    }
  }
}

resource "aws_iam_role" "cni" {
  name               = "${local.name}-vpc-cni"
  assume_role_policy = data.aws_iam_policy_document.cni_trust.json
}

resource "aws_iam_role_policy_attachment" "cni" {
  role       = aws_iam_role.cni.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.poc.name
  addon_name                  = "vpc-cni"
  addon_version               = var.addon_versions.vpc_cni
  service_account_role_arn    = aws_iam_role.cni.arn
  resolve_conflicts_on_update = "PRESERVE"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
  depends_on                  = [aws_iam_role_policy_attachment.cni]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.poc.name
  addon_name                  = "kube-proxy"
  addon_version               = var.addon_versions.kube_proxy
  resolve_conflicts_on_update = "PRESERVE"
  depends_on                  = [aws_eks_node_group.poc]
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.poc.name
  addon_name                  = "coredns"
  addon_version               = var.addon_versions.coredns
  resolve_conflicts_on_update = "PRESERVE"
  # One node cannot satisfy a no-downtime disruption budget during replacement.
  configuration_values = jsonencode({
    replicaCount        = 1
    podDisruptionBudget = { enabled = false }
  })
  depends_on = [aws_eks_node_group.poc]
}
