terraform {
  required_version = ">= 1.12, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = local.region
  allowed_account_ids = [local.account_id]

  default_tags {
    tags = {
      project     = "mend"
      environment = "aws-capture-poc"
    }
  }
}

locals {
  name       = "mend-capture-poc"
  account_id = "954648881795"
  region     = "eu-central-1"
  vpc_cidr   = "10.42.0.0/16"
  azs        = { for i, suffix in var.az_suffixes : "${local.region}${suffix}" => i }
}

data "aws_caller_identity" "current" {}
