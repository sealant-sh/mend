# The control plane on one EC2 instance, beside the EKS cluster until that is torn down
# (deploy/aws/README.md, "Single instance"). Off by default: an unchanged tfvars plans nothing new.
#
# The instance runs the packaged Compose bundle with deploy/docker/compose.aws.yaml behind the
# Caddy edge. It reuses this stack's VPC, capture bucket, PlanetScale endpoint and MicroVM
# connector. Sessions stay in Lambda MicroVMs: no tenant code runs on this host.
#
# Nothing secret is in this file, in user data or in state. The operator places .env over SSM.

variable "instance_enabled" {
  description = "Create the single-instance control plane. Independent of cluster_enabled."
  type        = bool
  default     = false
  nullable    = false
}

variable "instance_type" {
  description = "ARM64 instance type for the control plane. It runs no sessions."
  type        = string
  default     = "t4g.large"
  nullable    = false

  validation {
    condition     = can(regex("^(t4g|m7g|m8g|c7g|c8g|r7g|r8g)\\.", var.instance_type))
    error_message = "Use a Graviton (ARM64) instance type: the AMI and the Mend image are ARM64."
  }
}

variable "instance_hostname" {
  description = "Public name of the instance, e.g. alpha.mend.run. Its A record is yours to create, DNS-only."
  type        = string
  default     = "alpha.mend.run"
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.instance_hostname))
    error_message = "Provide a lowercase DNS name."
  }
}

variable "instance_data_gib" {
  description = "Size of the data volume that holds Docker's volumes: the store, config, SSH identity and the edge's certificates."
  type        = number
  default     = 40
  nullable    = false

  validation {
    condition     = var.instance_data_gib >= 20 && var.instance_data_gib <= 500
    error_message = "Choose between 20 and 500 GiB."
  }
}

locals {
  instance_count = var.instance_enabled ? 1 : 0
  instance_az    = "${local.region}${var.az_suffixes[0]}"
}

# Amazon Linux 2023, ARM64. The parameter moves with every AMI release, so the instance ignores
# later values: replacing the control plane is a decision, never a side effect of `tofu apply`.
data "aws_ssm_parameter" "al2023_arm64" {
  count = local.instance_count
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# One role for the instance. Mend, Sealant's API and its worker run in one container here, so the
# three identities the cluster keeps apart (application.tf) are one: the capture bucket, MicroVM
# control connections and MicroVM lifecycle. The policy documents are the cluster's, unchanged.
data "aws_iam_policy_document" "instance_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  count              = local.instance_count
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_trust.json
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  count      = local.instance_count
  role       = aws_iam_role.instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance_captures" {
  count  = local.instance_count
  name   = "capture-bucket-only"
  role   = aws_iam_role.instance[0].id
  policy = data.aws_iam_policy_document.mend_captures.json
}

resource "aws_iam_role_policy" "instance_microvm_control" {
  count  = local.instance_count
  name   = "microvm-control-connections"
  role   = aws_iam_role.instance[0].id
  policy = data.aws_iam_policy_document.sealant_api.json
}

resource "aws_iam_role_policy" "instance_microvm_lifecycle" {
  count  = local.instance_count
  name   = "microvm-lifecycle"
  role   = aws_iam_role.instance[0].id
  policy = data.aws_iam_policy_document.sealant_worker.json
}

resource "aws_iam_instance_profile" "instance" {
  count = local.instance_count
  name  = "${local.name}-instance"
  role  = aws_iam_role.instance[0].name
}

resource "aws_security_group" "instance" {
  count       = local.instance_count
  name        = "${local.name}-instance"
  description = "Control plane instance: the TLS edge, workspace SSH, and the session channel from MicroVMs only"
  vpc_id      = aws_vpc.poc.id
  tags        = { Name = "${local.name}-instance" }
}

resource "aws_vpc_security_group_ingress_rule" "instance_http" {
  count             = local.instance_count
  security_group_id = aws_security_group.instance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "ACME HTTP-01 and the redirect to HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "instance_https" {
  count             = local.instance_count
  security_group_id = aws_security_group.instance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "The edge: the only way in to the Mend web tier"
}

resource "aws_vpc_security_group_ingress_rule" "instance_http3" {
  count             = local.instance_count
  security_group_id = aws_security_group.instance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "udp"
  from_port         = 443
  to_port           = 443
  description       = "HTTP/3 to the edge"
}

resource "aws_vpc_security_group_ingress_rule" "instance_workspace_ssh" {
  count             = local.instance_count
  security_group_id = aws_security_group.instance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 2222
  to_port           = 2222
  description       = "Mend workspace SSH gateway, public keys only. The host sshd is not published"
}

resource "aws_vpc_security_group_ingress_rule" "instance_session_channel" {
  count                        = local.instance_count
  security_group_id            = aws_security_group.instance[0].id
  referenced_security_group_id = aws_security_group.microvm.id
  ip_protocol                  = "tcp"
  from_port                    = 3106
  to_port                      = 3106
  description                  = "Session channel from the MicroVM connector only; VPC-internal plain HTTP, declared private"
}

resource "aws_vpc_security_group_egress_rule" "instance" {
  count             = local.instance_count
  security_group_id = aws_security_group.instance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "PlanetScale endpoint, S3, Lambda and ACME; image pulls and git"
}

resource "aws_vpc_security_group_ingress_rule" "planetscale_from_instance" {
  count                        = local.instance_count
  security_group_id            = aws_security_group.planetscale.id
  referenced_security_group_id = aws_security_group.instance[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the control plane instance"
}

resource "aws_instance" "control_plane" {
  count                       = local.instance_count
  ami                         = data.aws_ssm_parameter.al2023_arm64[0].value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public[local.instance_az].id
  vpc_security_group_ids      = [aws_security_group.instance[0].id]
  iam_instance_profile        = aws_iam_instance_profile.instance[0].name
  associate_public_ip_address = false # the Elastic IP below is its only public address
  user_data                   = file("${path.module}/instance-user-data.sh")
  user_data_replace_on_change = false

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    # Two hops: the Mend container, one bridge away, needs the instance role for S3 and Lambda.
    # The edge is kept off the metadata address by the host firewall rule in user data.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = "${local.name}-control-plane" }
}

# Docker's data root lives here, so every named volume (the store, config, the SSH host key, the
# edge's certificates) outlives the instance and is what the snapshots below capture.
resource "aws_ebs_volume" "instance_data" {
  count             = local.instance_count
  availability_zone = local.instance_az
  type              = "gp3"
  size              = var.instance_data_gib
  encrypted         = true
  tags              = { Name = "${local.name}-instance-data", snapshot = "daily" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "instance_data" {
  count       = local.instance_count
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.instance_data[0].id
  instance_id = aws_instance.control_plane[0].id
}

resource "aws_eip" "instance" {
  count  = local.instance_count
  domain = "vpc"
  tags   = { Name = "${local.name}-instance" }
}

resource "aws_eip_association" "instance" {
  count         = local.instance_count
  allocation_id = aws_eip.instance[0].id
  instance_id   = aws_instance.control_plane[0].id
}

# Daily snapshots of the data volume, seven kept. PlanetScale and S3 hold the rest of the state.
data "aws_iam_policy_document" "dlm_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  count              = local.instance_count
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_trust.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  count      = local.instance_count
  role       = aws_iam_role.dlm[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "instance_data" {
  count              = local.instance_count
  description        = "${local.name} instance data daily"
  execution_role_arn = aws_iam_role.dlm[0].arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { snapshot = "daily" }

    schedule {
      name = "daily"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = 7
      }
      copy_tags = true
    }
  }
}

output "instance_id" {
  value = one(aws_instance.control_plane[*].id)
}
output "instance_public_ip" {
  description = "Point the DNS-only A record for instance_hostname here."
  value       = one(aws_eip.instance[*].public_ip)
}
output "instance_private_ip" {
  value = one(aws_instance.control_plane[*].private_ip)
}
output "instance_hostname" {
  value = var.instance_enabled ? var.instance_hostname : null
}
output "instance_session_endpoint_url" {
  description = "MEND_SESSION_ENDPOINT_URL for compose.aws.yaml: what MicroVMs dial, inside the VPC."
  value       = var.instance_enabled ? "http://${aws_instance.control_plane[0].private_ip}:3106" : null
}
output "microvm_ingress_connector_arn" {
  description = "AWS's managed ingress connector, the value the cluster's renderer hard-codes."
  value       = "arn:aws:lambda:${local.region}:aws:network-connector:aws-network-connector:ALL_INGRESS"
}
output "instance_shell_command" {
  value = var.instance_enabled ? "aws ssm start-session --region ${local.region} --target ${aws_instance.control_plane[0].id}" : null
}
output "instance_first_account_tunnel" {
  description = "Forward Mend's loopback port to this machine to create the first account over a private path."
  value       = var.instance_enabled ? "aws ssm start-session --region ${local.region} --target ${aws_instance.control_plane[0].id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3105,localPortNumber=3105" : null
}
