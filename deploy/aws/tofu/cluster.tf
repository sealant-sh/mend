# The EKS cluster is one of this stack's two control planes; instance.tf is the other. Both reuse
# the VPC, the buckets, the PlanetScale endpoint and the MicroVM connector and roles, which are
# never gated. `cluster_enabled = false` removes the cluster and what only it uses: its node group
# and add-ons, the EBS CSI role, the three service-account roles, the session load balancer and the
# EKS workload security group. Read TEARDOWN.md before turning it off on a cluster that has run:
# PVCs must be deleted while the EBS CSI controller still exists.
variable "cluster_enabled" {
  description = "Create the EKS control plane. The single instance (instance_enabled) is independent of it."
  type        = bool
  default     = true
  nullable    = false
}

locals {
  cluster_count = var.cluster_enabled ? 1 : 0
}

# These resources had no count before the flag. Without the moves, a state made earlier would see
# every one of them deleted and created again, the cluster included.
moved {
  from = aws_iam_role.eks
  to   = aws_iam_role.eks[0]
}

moved {
  from = aws_iam_role_policy_attachment.eks
  to   = aws_iam_role_policy_attachment.eks[0]
}

moved {
  from = aws_cloudwatch_log_group.eks
  to   = aws_cloudwatch_log_group.eks[0]
}

moved {
  from = aws_eks_cluster.poc
  to   = aws_eks_cluster.poc[0]
}

moved {
  from = aws_iam_openid_connect_provider.eks
  to   = aws_iam_openid_connect_provider.eks[0]
}

moved {
  from = aws_iam_role.node
  to   = aws_iam_role.node[0]
}

moved {
  from = aws_launch_template.node
  to   = aws_launch_template.node[0]
}

moved {
  from = aws_eks_node_group.poc
  to   = aws_eks_node_group.poc[0]
}

moved {
  from = aws_iam_role.cni
  to   = aws_iam_role.cni[0]
}

moved {
  from = aws_iam_role_policy_attachment.cni
  to   = aws_iam_role_policy_attachment.cni[0]
}

moved {
  from = aws_eks_addon.vpc_cni
  to   = aws_eks_addon.vpc_cni[0]
}

moved {
  from = aws_eks_addon.kube_proxy
  to   = aws_eks_addon.kube_proxy[0]
}

moved {
  from = aws_eks_addon.coredns
  to   = aws_eks_addon.coredns[0]
}

moved {
  from = aws_iam_role.ebs_csi
  to   = aws_iam_role.ebs_csi[0]
}

moved {
  from = aws_iam_role_policy.ebs_csi
  to   = aws_iam_role_policy.ebs_csi[0]
}

moved {
  from = aws_eks_addon.ebs_csi
  to   = aws_eks_addon.ebs_csi[0]
}

moved {
  from = aws_iam_role_policy.mend_captures
  to   = aws_iam_role_policy.mend_captures[0]
}

moved {
  from = aws_iam_role_policy.sealant_api
  to   = aws_iam_role_policy.sealant_api[0]
}

moved {
  from = aws_iam_role_policy.sealant_worker
  to   = aws_iam_role_policy.sealant_worker[0]
}

moved {
  from = aws_security_group.session_nlb
  to   = aws_security_group.session_nlb[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.session_nlb
  to   = aws_vpc_security_group_ingress_rule.session_nlb[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.session_nlb
  to   = aws_vpc_security_group_egress_rule.session_nlb[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.session_nodeport
  to   = aws_vpc_security_group_ingress_rule.session_nodeport[0]
}

moved {
  from = aws_lb.session
  to   = aws_lb.session[0]
}

moved {
  from = aws_lb_target_group.session
  to   = aws_lb_target_group.session[0]
}

moved {
  from = aws_lb_listener.session
  to   = aws_lb_listener.session[0]
}

moved {
  from = aws_autoscaling_attachment.session
  to   = aws_autoscaling_attachment.session[0]
}

moved {
  from = aws_security_group.eks_workload
  to   = aws_security_group.eks_workload[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.eks_internal
  to   = aws_vpc_security_group_ingress_rule.eks_internal[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.eks
  to   = aws_vpc_security_group_egress_rule.eks[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.planetscale
  to   = aws_vpc_security_group_ingress_rule.planetscale[0]
}
