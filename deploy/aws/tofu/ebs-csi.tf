data "aws_iam_policy_document" "ebs_csi_trust" {
  count = local.cluster_count
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  count              = local.cluster_count
  name               = "${local.name}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_trust[0].json
}

# Fresh encrypted gp3 PVCs only. Snapshot restore, snapshot management, FSR and
# customer-managed KMS keys intentionally have no permission in this POC.
data "aws_iam_policy_document" "ebs_csi" {
  statement {
    sid = "DescribeRegionalEC2"
    actions = [
      "ec2:DescribeAvailabilityZones", "ec2:DescribeInstances", "ec2:DescribeSnapshots",
      "ec2:DescribeTags", "ec2:DescribeVolumes", "ec2:DescribeVolumesModifications",
      "ec2:DescribeVolumeStatus",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  statement {
    sid       = "CreateClusterVolumes"
    actions   = ["ec2:CreateVolume"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/mend-cluster"
      values   = [local.name]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ebs.csi.aws.com/cluster"
      values   = ["true"]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:VolumeType"
      values   = ["gp3"]
    }
    condition {
      test     = "Bool"
      variable = "ec2:Encrypted"
      values   = ["true"]
    }
  }

  statement {
    sid       = "TagOnCreateOnly"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateVolume"]
    }
  }

  statement {
    sid       = "ManageClusterVolumes"
    actions   = ["ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:AttachVolume", "ec2:DetachVolume"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mend-cluster"
      values   = [local.name]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ebs.csi.aws.com/cluster"
      values   = ["true"]
    }
  }

  statement {
    sid       = "AttachToClusterNodes"
    actions   = ["ec2:AttachVolume", "ec2:DetachVolume"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mend-cluster"
      values   = [local.name]
    }
  }
}

resource "aws_iam_role_policy" "ebs_csi" {
  count  = local.cluster_count
  name   = "cluster-gp3-volumes"
  role   = aws_iam_role.ebs_csi[0].id
  policy = data.aws_iam_policy_document.ebs_csi.json
}

resource "aws_eks_addon" "ebs_csi" {
  count                       = local.cluster_count
  cluster_name                = aws_eks_cluster.poc[0].name
  addon_name                  = "aws-ebs-csi-driver"
  addon_version               = var.addon_versions.ebs_csi
  service_account_role_arn    = aws_iam_role.ebs_csi[0].arn
  resolve_conflicts_on_update = "PRESERVE"
  configuration_values = jsonencode({
    controller = {
      replicaCount        = 1
      podDisruptionBudget = { enabled = false }
      extraVolumeTags = {
        project        = "mend"
        environment    = "aws-capture-poc"
        "mend-cluster" = local.name
      }
    }
  })
  depends_on = [aws_iam_role_policy.ebs_csi, aws_eks_node_group.poc, aws_eks_addon.coredns]
}
