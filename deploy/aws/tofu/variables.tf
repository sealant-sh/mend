variable "operator_cidrs" {
  description = "Explicit public IPv4 CIDRs allowed to reach the EKS API. Prefer operator /32s. No app ingress."
  type        = set(string)
  nullable    = false

  validation {
    condition = length(var.operator_cidrs) > 0 && alltrue([
      for cidr in var.operator_cidrs : can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) >= 24, false)
    ])
    error_message = "Supply at least one valid IPv4 CIDR, /24 or narrower; 0.0.0.0/0 is forbidden."
  }
}

variable "budget_email" {
  description = "Recipient for the $100 monthly AWS account budget. Not a credential."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "Provide the budget alert recipient's email address."
  }
}

variable "az_suffixes" {
  description = "Exactly two PlanetScale-supported AZs, in stable subnet order. Changing order replaces subnets."
  type        = list(string)
  default     = ["a", "b"]
  nullable    = false

  validation {
    condition = length(var.az_suffixes) == 2 && length(toset(var.az_suffixes)) == 2 && alltrue([
      for az in var.az_suffixes : contains(["a", "b", "c"], az)
    ])
    error_message = "Choose two distinct AZ suffixes from a, b, c."
  }
}

variable "kubernetes_version" {
  description = "Exact EKS minor version; 1.35 was in STANDARD_SUPPORT at read-only verification. Update add-on and AMI pins together."
  type        = string
  default     = "1.35"
  nullable    = false

  validation {
    condition     = can(regex("^1\\.[0-9]+$", var.kubernetes_version))
    error_message = "Use an exact EKS minor version such as 1.35, not latest or a patch version."
  }
}

variable "node_release_version" {
  description = "Pinned EKS AL2023 ARM64 standard AMI release for kubernetes_version."
  type        = string
  default     = "1.35.7-20260911"
  nullable    = false

  validation {
    condition     = startswith(var.node_release_version, "${var.kubernetes_version}.")
    error_message = "The AMI release must match kubernetes_version."
  }
}

variable "addon_versions" {
  description = "Exact ARM64-compatible EKS add-on builds. Recheck compatibility when changing Kubernetes version."
  type = object({
    vpc_cni    = string
    coredns    = string
    kube_proxy = string
    ebs_csi    = string
  })
  default = {
    vpc_cni    = "v1.23.1-eksbuild.1"
    coredns    = "v1.14.3-eksbuild.22"
    kube_proxy = "v1.35.3-eksbuild.29"
    ebs_csi    = "v1.66.0-eksbuild.1"
  }
  nullable = false

  validation {
    condition     = alltrue([for version in values(var.addon_versions) : can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$", version))])
    error_message = "Pin every add-on to an exact vX.Y.Z-eksbuild.N version."
  }
}
