resource "aws_vpc" "poc" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_default_security_group" "poc" {
  vpc_id = aws_vpc.poc.id
  # Empty: nothing should use the VPC default security group.
  tags = { Name = "${local.name}-unused-default" }
}

resource "aws_internet_gateway" "poc" {
  vpc_id = aws_vpc.poc.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.poc.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 8, each.value)
  availability_zone       = each.key
  map_public_ip_on_launch = false
  # No public load-balancer discovery tag: app ingress is not part of this stack.
  tags = { Name = "${local.name}-public-${each.key}", tier = "public" }
}

resource "aws_subnet" "private" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.poc.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, each.value + 1)
  availability_zone       = each.key
  map_public_ip_on_launch = false
  tags = {
    Name                              = "${local.name}-private-${each.key}"
    tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "poc" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public["${local.region}${var.az_suffixes[0]}"].id
  depends_on    = [aws_internet_gateway.poc]
  tags          = { Name = local.name }
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
  for_each = local.azs
  vpc_id   = aws_vpc.poc.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.poc.id
  }
  tags = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_route_table_association" "public" {
  for_each       = local.azs
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each       = local.azs
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.poc.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for route in aws_route_table.private : route.id]
  # The endpoint grants no IAM access. Keep it usable for presigned captures and ECR layers.
  tags = { Name = "${local.name}-s3" }
}

resource "aws_security_group" "eks_workload" {
  name        = "${local.name}-eks-workload"
  description = "Dedicated EKS control-plane and node ENIs, never MicroVM connectors"
  vpc_id      = aws_vpc.poc.id
  tags        = { Name = "${local.name}-eks-workload" }
}

resource "aws_vpc_security_group_ingress_rule" "eks_internal" {
  security_group_id            = aws_security_group.eks_workload.id
  referenced_security_group_id = aws_security_group.eks_workload.id
  ip_protocol                  = "-1"
  description                  = "EKS API, kubelet, DNS, and pod traffic within the EKS group"
}

resource "aws_vpc_security_group_egress_rule" "eks" {
  security_group_id = aws_security_group.eks_workload.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "PrivateLink, S3 endpoint, and outbound package/image/API traffic through NAT"
}

resource "aws_security_group" "microvm" {
  name        = "${local.name}-microvm"
  description = "MicroVM egress connector only; no database or node ingress rights"
  vpc_id      = aws_vpc.poc.id
  tags        = { Name = "${local.name}-microvm" }
}

resource "aws_vpc_security_group_egress_rule" "microvm" {
  security_group_id = aws_security_group.microvm.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound agent traffic and presigned S3 requests; destination SGs gate VPC access"
}

resource "aws_security_group" "planetscale" {
  name        = "${local.name}-planetscale"
  description = "PlanetScale PrivateLink: PostgreSQL from EKS only"
  vpc_id      = aws_vpc.poc.id
  tags        = { Name = "${local.name}-planetscale" }
}

resource "aws_vpc_security_group_ingress_rule" "planetscale" {
  security_group_id            = aws_security_group.planetscale.id
  referenced_security_group_id = aws_security_group.eks_workload.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from EKS; no MicroVM source permitted"
}

resource "aws_vpc_endpoint" "planetscale" {
  vpc_id              = aws_vpc.poc.id
  service_name        = "com.amazonaws.vpce.eu-central-1.vpce-svc-09601f829d1a52f57"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.private : subnet.id]
  security_group_ids  = [aws_security_group.planetscale.id]
  tags                = { Name = "${local.name}-planetscale" }
}
