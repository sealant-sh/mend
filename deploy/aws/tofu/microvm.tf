# Images and running MicroVMs belong to Sealant's public runtime integration,
# not this infrastructure stack. These roles and the connector are its inputs.
resource "aws_ecr_repository" "workspace" {
  name                 = "mend/capture-workspace"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "microvm_build" {
  name              = "/aws/lambda/microvms/${local.name}-build"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "microvm_exec" {
  name              = "/aws/lambda/microvms/${local.name}-runtime"
  retention_in_days = 14
}

data "aws_iam_policy_document" "microvm_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "microvm_build" {
  name               = "${local.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.microvm_trust.json
}

data "aws_iam_policy_document" "microvm_build" {
  # A step of a project's image recipe runs as root under this role and can read its credentials
  # from the instance metadata service (measured 2026-09-20). So it can read one prefix and write
  # its build log, and nothing else: no PutObject, no ListBucket, no registry. Base images come
  # from public registries, and the daemon from its public release image.
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/${local.microvm_artifact_prefix}/*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.microvm_build.arn}:*"]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  name   = "artifacts-and-build-logs"
  role   = aws_iam_role.microvm_build.id
  policy = data.aws_iam_policy_document.microvm_build.json
}

# Hostile agent code gets no S3 credentials, database access, MicroVM management,
# ENI management, or PassRole. Captures move using per-key presigned URLs.
resource "aws_iam_role" "microvm_exec" {
  name               = "${local.name}-microvm-exec"
  assume_role_policy = data.aws_iam_policy_document.microvm_trust.json
}

data "aws_iam_policy_document" "microvm_exec" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.microvm_exec.arn}:*"]
  }
}

resource "aws_iam_role_policy" "microvm_exec" {
  name   = "runtime-logs-only"
  role   = aws_iam_role.microvm_exec.id
  policy = data.aws_iam_policy_document.microvm_exec.json
}

data "aws_iam_policy_document" "connector_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["network-connectors.lambda.amazonaws.com", "lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "connector_operator" {
  name               = "${local.name}-connector-operator"
  assume_role_policy = data.aws_iam_policy_document.connector_trust.json
}

data "aws_iam_policy_document" "connector_operator" {
  statement {
    sid     = "CreateENIInMicroVMSubnetsOnly"
    actions = ["ec2:CreateNetworkInterface"]
    resources = concat(
      ["arn:aws:ec2:${local.region}:${local.account_id}:network-interface/*", aws_security_group.microvm.arn],
      [for subnet in aws_subnet.private : subnet.arn],
    )
  }
  statement {
    sid       = "TagManagedENI"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:network-interface/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ManagedResourceOperator"
      values   = ["network-connectors.lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "connector_operator" {
  name   = "microvm-connector-enis"
  role   = aws_iam_role.connector_operator.id
  policy = data.aws_iam_policy_document.connector_operator.json
}

resource "aws_lambdacore_network_connector" "vpc_egress" {
  name          = "${local.name}-vpc-egress"
  operator_role = aws_iam_role.connector_operator.arn
  configuration {
    vpc_egress_configuration {
      associated_compute_resource_types = ["MicroVm"]
      network_protocol                  = "IPv4"
      subnet_ids                        = [for subnet in aws_subnet.private : subnet.id]
      security_group_ids                = [aws_security_group.microvm.id]
    }
  }
  # Provider 6.64.0 exposes no tags on this resource.
  depends_on = [
    aws_iam_role_policy.connector_operator,
    aws_route_table_association.private,
    aws_vpc_security_group_egress_rule.microvm,
  ]
}
