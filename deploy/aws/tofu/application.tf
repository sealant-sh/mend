# Application identities. No static AWS credentials or bucket access on the node role.
locals {
  microvm_image_name = "mend-capture-poc-workspace"
  microvm_image_arn  = "arn:aws:lambda:${local.region}:${local.account_id}:microvm-image:${local.microvm_image_name}"
  application_subjects = {
    mend           = "system:serviceaccount:mend:mend-api"
    sealant_api    = "system:serviceaccount:sealant:sealant-api"
    sealant_worker = "system:serviceaccount:sealant:sealant-worker"
  }
}

data "aws_iam_policy_document" "application_trust" {
  for_each = local.application_subjects
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
      values   = [each.value]
    }
  }
}

resource "aws_iam_role" "application" {
  for_each           = local.application_subjects
  name               = "${local.name}-${replace(each.key, "_", "-")}"
  assume_role_policy = data.aws_iam_policy_document.application_trust[each.key].json
}

data "aws_iam_policy_document" "mend_captures" {
  statement {
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.captures.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${aws_s3_bucket.captures.arn}/*"]
  }
}

resource "aws_iam_role_policy" "mend_captures" {
  name   = "capture-bucket-only"
  role   = aws_iam_role.application["mend"].id
  policy = data.aws_iam_policy_document.mend_captures.json
}

data "aws_iam_policy_document" "sealant_api" {
  statement {
    actions = ["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm"]
    # These operations authorize against the image, not an individual VM ARN.
    resources = [local.microvm_image_arn]
  }
}

resource "aws_iam_role_policy" "sealant_api" {
  name   = "microvm-control-connections"
  role   = aws_iam_role.application["sealant_api"].id
  policy = data.aws_iam_policy_document.sealant_api.json
}

data "aws_iam_policy_document" "sealant_worker" {
  statement {
    actions   = ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:TerminateMicrovm", "lambda:CreateMicrovmAuthToken"]
    resources = [local.microvm_image_arn]
  }
  statement {
    # RunMicrovm rejected an otherwise matching grant with
    # iam:PassedToService=lambda.amazonaws.com in the live POC. Keep this
    # restricted to the log-only runtime role, whose trust permits Lambda only.
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.microvm_exec.arn]
  }
  statement {
    # AWS's service-authorization table lists no resource-level support for this action.
    actions   = ["lambda:PassNetworkConnector"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sealant_worker" {
  name   = "microvm-lifecycle"
  role   = aws_iam_role.application["sealant_worker"].id
  policy = data.aws_iam_policy_document.sealant_worker.json
}

# Raw TCP preserves HTTP CONNECT for Git and the authenticated session/capture protocol.
# This listener is VPC-only HTTP; it does not claim TLS. Browser traffic never uses it.
resource "aws_security_group" "session_nlb" {
  name        = "${local.name}-session-nlb"
  description = "Private Mend session channel from the MicroVM connector only"
  vpc_id      = aws_vpc.poc.id
}
resource "aws_vpc_security_group_ingress_rule" "session_nlb" {
  security_group_id            = aws_security_group.session_nlb.id
  referenced_security_group_id = aws_security_group.microvm.id
  ip_protocol                  = "tcp"
  from_port                    = 3106
  to_port                      = 3106
}
resource "aws_vpc_security_group_egress_rule" "session_nlb" {
  security_group_id            = aws_security_group.session_nlb.id
  referenced_security_group_id = aws_security_group.eks_workload.id
  ip_protocol                  = "tcp"
  from_port                    = 31006
  to_port                      = 31006
}
resource "aws_vpc_security_group_ingress_rule" "session_nodeport" {
  security_group_id            = aws_security_group.eks_workload.id
  referenced_security_group_id = aws_security_group.session_nlb.id
  ip_protocol                  = "tcp"
  from_port                    = 31006
  to_port                      = 31006
}
resource "aws_lb" "session" {
  name                             = "${local.name}-session"
  internal                         = true
  load_balancer_type               = "network"
  subnets                          = [for subnet in aws_subnet.private : subnet.id]
  security_groups                  = [aws_security_group.session_nlb.id]
  enable_cross_zone_load_balancing = true
}
resource "aws_lb_target_group" "session" {
  name                 = "${local.name}-session"
  vpc_id               = aws_vpc.poc.id
  protocol             = "TCP"
  port                 = 31006
  target_type          = "instance"
  preserve_client_ip   = false
  deregistration_delay = 10
  health_check {
    protocol = "TCP"
    port     = "traffic-port"
  }
}
resource "aws_lb_listener" "session" {
  load_balancer_arn = aws_lb.session.arn
  protocol          = "TCP"
  port              = 3106
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.session.arn
  }
}
resource "aws_autoscaling_attachment" "session" {
  autoscaling_group_name = aws_eks_node_group.poc.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.session.arn
}
output "application_role_arns" {
  value = { for name, role in aws_iam_role.application : name => role.arn }
}
output "session_endpoint_url" {
  value = "http://${aws_lb.session.dns_name}:3106"
}
output "microvm_image_name" { value = local.microvm_image_name }
output "microvm_image_arn" { value = local.microvm_image_arn }
