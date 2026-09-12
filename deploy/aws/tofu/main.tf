# Mend AWS MicroVM POC · slice 0 · network, FSx store, IAM, artifacts.
#
# One VPC, one AZ. Everything carries the two POC tags so Cost Explorer can
# show the whole experiment, and `tofu destroy` removes it all.
#
# Not managed here: the Lambda MicroVM image (the provider resource has no
# hooks/resources/logging arguments yet), created by ../scripts/01-build-image.sh
# from this module's outputs. The VPC egress connector IS managed here.

terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project     = "mend"
      environment = "aws-microvm-poc"
    }
  }
}

locals {
  name = "mend-poc"
  az   = "${var.region}${var.az_suffix}"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------- network ----

resource "aws_vpc" "poc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "poc" {
  vpc_id = aws_vpc.poc.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.poc.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, 0)
  availability_zone       = local.az
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public", tier = "public" }
}

# MicroVM egress ENIs, FSx, and later the EKS nodes live here.
resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.poc.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 1)
  availability_zone = local.az
  tags              = { Name = "${local.name}-private", tier = "private" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "poc" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = local.name }
  depends_on    = [aws_internet_gateway.poc]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.poc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.poc.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.poc.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.poc.id
  }
  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# S3 gateway endpoint: free, keeps ECR layer pulls and artifact reads off NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.poc.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${local.name}-s3" }
}

# -------------------------------------------------------- security groups ----

# Attached to the MicroVM egress connector ENIs (and later the EKS nodes).
resource "aws_security_group" "workload" {
  name        = "${local.name}-workload"
  description = "MicroVM egress ENIs and control-plane nodes"
  vpc_id      = aws_vpc.poc.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-workload" }
}

# FSx accepts NFS only from the workload group.
resource "aws_security_group" "fsx" {
  name        = "${local.name}-fsx"
  description = "FSx for OpenZFS NFS from workloads"
  vpc_id      = aws_vpc.poc.id
  ingress {
    description     = "NFS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.workload.id]
  }
  ingress {
    description     = "NFS v3/v4.0 side ports (rpcbind, mountd, nlockmgr)"
    from_port       = 111
    to_port         = 111
    protocol        = "tcp"
    security_groups = [aws_security_group.workload.id]
  }
  ingress {
    from_port       = 111
    to_port         = 111
    protocol        = "udp"
    security_groups = [aws_security_group.workload.id]
  }
  ingress {
    from_port       = 20001
    to_port         = 20003
    protocol        = "tcp"
    security_groups = [aws_security_group.workload.id]
  }
  ingress {
    from_port       = 20001
    to_port         = 20003
    protocol        = "udp"
    security_groups = [aws_security_group.workload.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-fsx" }
}

# ---------------------------------------------------------------- storage ----

# The authoritative Mend store. Single-AZ, non-HA, SSD, smallest sensible tier.
# Export options: every NFS writer (engine pod uid 1000, root inside VMs) maps
# to one owner, which ends the uid split documented in PLATFORM-FEEDBACK.md.
# `insecure` is required: the default `secure` accepts only source ports below
# 1024, and MicroVM traffic arrives through the connector ENI's NAT on an
# ephemeral port, which the server answers with NFS4ERR_PERM (mount says
# "Operation not permitted").
resource "aws_fsx_openzfs_file_system" "store" {
  deployment_type     = var.fsx_deployment_type
  storage_capacity    = var.fsx_storage_gib
  throughput_capacity = var.fsx_throughput_mbps
  subnet_ids          = [aws_subnet.private.id]
  security_group_ids  = [aws_security_group.fsx.id]
  storage_type        = "SSD"

  automatic_backup_retention_days   = 7
  daily_automatic_backup_start_time = "02:00"
  copy_tags_to_backups              = true
  copy_tags_to_volumes              = true
  skip_final_backup                 = true

  root_volume_configuration {
    data_compression_type = "LZ4"
    record_size_kib       = 128
    nfs_exports {
      client_configurations {
        clients = var.vpc_cidr
        options = ["rw", "crossmnt", "insecure", "all_squash", "anonuid=1000", "anongid=1000"]
      }
    }
  }

  tags = { Name = "${local.name}-store" }
}

# One child volume for the Mend store so the root stays free for snapshots and
# a future second tenant/cell.
resource "aws_fsx_openzfs_volume" "mend" {
  name                  = "mend"
  parent_volume_id      = aws_fsx_openzfs_file_system.store.root_volume_id
  data_compression_type = "LZ4"
  record_size_kib       = 128
  nfs_exports {
    client_configurations {
      clients = var.vpc_cidr
      options = ["rw", "crossmnt", "insecure", "all_squash", "anonuid=1000", "anongid=1000"]
    }
  }
  # No Name tag here: the file system copies its tags to volumes and rejects a
  # volume whose Name differs from its own.
}

# ------------------------------------------------------------- artifacts ----

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.name}-artifacts-${data.aws_caller_identity.current.account_id}-${var.region}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ecr_repository" "workspace" {
  name                 = "mend/workspace"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = false }
}

# ------------------------------------------------------------------- iam ----

# Roles the MicroVM service assumes. Trust follows the AWS sample: the
# lambda.amazonaws.com principal with AssumeRole + TagSession.
data "aws_iam_policy_document" "microvm_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Build role: read the image source zip, write build logs.
resource "aws_iam_role" "microvm_build" {
  name               = "${local.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.microvm_trust.json
}

data "aws_iam_policy_document" "microvm_build" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
  }
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.workspace.arn]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/microvms/*"]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  role   = aws_iam_role.microvm_build.id
  policy = data.aws_iam_policy_document.microvm_build.json
}

# Execution role: what code INSIDE the VM can do with AWS. Deliberately almost
# nothing: logs only. Agent code in the VM is treated as hostile.
resource "aws_iam_role" "microvm_exec" {
  name               = "${local.name}-microvm-exec"
  assume_role_policy = data.aws_iam_policy_document.microvm_trust.json
}

data "aws_iam_policy_document" "microvm_exec" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/microvms/*"]
  }
}

resource "aws_iam_role_policy" "microvm_exec" {
  role   = aws_iam_role.microvm_exec.id
  policy = data.aws_iam_policy_document.microvm_exec.json
}

# Operator role for the VPC egress network connector: lets Lambda create ENIs
# in the private subnet. Copied from the MicroVM networking guide.
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
    sid     = "CreateENI"
    actions = ["ec2:CreateNetworkInterface"]
    resources = [
      "arn:aws:ec2:*:*:network-interface/*",
      "arn:aws:ec2:*:*:subnet/*",
      "arn:aws:ec2:*:*:security-group/*",
    ]
  }
  statement {
    sid       = "TagENI"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:*:*:network-interface/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ManagedResourceOperator"
      values   = ["network-connectors.lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "connector_operator" {
  role   = aws_iam_role.connector_operator.id
  policy = data.aws_iam_policy_document.connector_operator.json
}

# The VPC egress connector every MicroVM runs with: one shared connector, ENIs
# in the private subnet, so VMs reach FSx over NFS and the internet via NAT.
resource "aws_lambdacore_network_connector" "vpc_egress" {
  name          = "${local.name}-vpc-egress"
  operator_role = aws_iam_role.connector_operator.arn
  configuration {
    vpc_egress_configuration {
      associated_compute_resource_types = ["MicroVm"]
      network_protocol                  = "IPv4"
      subnet_ids                        = [aws_subnet.private.id]
      security_group_ids                = [aws_security_group.workload.id]
    }
  }
  depends_on = [aws_iam_role_policy.connector_operator]
}

# The MicroVM image itself is created by ../scripts/01-build-image.sh with the
# CLI: the provider's aws_lambdamicrovms_image resource has no `hooks`,
# `resources` or `logging` arguments yet, and the bench image needs all three.

# ------------------------------------------------------------ observability ----

resource "aws_cloudwatch_log_group" "microvm_bench" {
  name              = "/aws/lambda/microvms/${local.name}-bench"
  retention_in_days = 14
}

resource "aws_budgets_budget" "poc" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:environment$aws-microvm-poc"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
