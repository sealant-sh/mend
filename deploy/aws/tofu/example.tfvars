# Copy to poc.tfvars, which is ignored. Never put AWS or database credentials here.
# Replace BOTH example values before planning. 203.0.113.0/24 is documentation space.
operator_cidrs = ["203.0.113.10/32"]
budget_email   = "operator@example.com"

az_suffixes          = ["a", "b"]
kubernetes_version   = "1.35"
node_release_version = "1.35.7-20260911"
addon_versions = {
  vpc_cni    = "v1.23.1-eksbuild.1"
  coredns    = "v1.14.3-eksbuild.22"
  kube_proxy = "v1.35.3-eksbuild.29"
  ebs_csi    = "v1.66.0-eksbuild.1"
}
