variable "region" {
  description = "AWS region. Needs Lambda MicroVMs and FSx for OpenZFS SINGLE_AZ_2."
  type        = string
  default     = "eu-central-1"
}

variable "az_suffix" {
  description = "Single availability zone suffix; everything sits in one AZ on purpose."
  type        = string
  default     = "a"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "fsx_deployment_type" {
  description = "SINGLE_AZ_2 has the larger cache and NVMe read cache; SINGLE_AZ_1 is the cheapest tier."
  type        = string
  default     = "SINGLE_AZ_2"
}

variable "fsx_storage_gib" {
  type    = number
  default = 64
}

variable "fsx_throughput_mbps" {
  description = "160 is the SINGLE_AZ_2 minimum; 64 the SINGLE_AZ_1 minimum."
  type        = number
  default     = 160
}

variable "monthly_budget_usd" {
  type    = number
  default = 400
}

variable "budget_email" {
  description = "Where the budget alarms go."
  type        = string
}
