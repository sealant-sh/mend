# Plan-only fixtures. Mock only computed values; do not change production gates or apply.
mock_provider "aws" {
  mock_resource "aws_eks_node_group" {
    defaults = { resources = [{ autoscaling_groups = [{ name = "owned-fixture-asg" }], remote_access_security_group_id = "sg-0123456789abcdef0" }] }
  }

  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-central-1:000000000000:loadbalancer/net/fixture/0123456789abcdef" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/fixture/0123456789abcdef" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/mend-fixture" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = { identity = [{ oidc = [{ issuer = "https://oidc.eks.eu-central-1.amazonaws.com/id/fixture" }] }], certificate_authority = [{ data = "Zml4dHVyZQ==" }] }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}
variables {
  operator_cidrs = ["192.0.2.1/32"]
  budget_email   = "fixture@example.invalid"
}
run "both_disabled" {
  command = plan
  plan_options { refresh = false }
  variables {
    cluster_enabled  = false
    instance_enabled = false
  }
  assert {
    condition     = length(aws_eks_cluster.poc) == 0 && length(aws_instance.control_plane) == 0
    error_message = "Control-plane cardinality must match the independent input expectation."
  }
}
run "cluster_only" {
  command = plan
  plan_options { refresh = false }
  variables {
    cluster_enabled  = true
    instance_enabled = false
  }
  assert {
    condition     = length(aws_eks_cluster.poc) == 1 && length(aws_instance.control_plane) == 0
    error_message = "Control-plane cardinality must match the independent input expectation."
  }
}
run "instance_only" {
  command = plan
  plan_options { refresh = false }
  variables {
    cluster_enabled  = false
    instance_enabled = true
  }
  assert {
    condition     = length(aws_eks_cluster.poc) == 0 && length(aws_instance.control_plane) == 1
    error_message = "Control-plane cardinality must match the independent input expectation."
  }
}
run "both_enabled" {
  command = plan
  plan_options { refresh = false }
  variables {
    cluster_enabled  = true
    instance_enabled = true
  }
  assert {
    condition     = length(aws_eks_cluster.poc) == 1 && length(aws_instance.control_plane) == 1
    error_message = "Control-plane cardinality must match the independent input expectation."
  }
}
