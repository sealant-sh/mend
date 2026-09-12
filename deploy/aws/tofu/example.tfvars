# Copy to poc.tfvars and fill in. poc.tfvars is gitignored.
region       = "eu-central-1"
budget_email = "you@example.com"
# fsx_deployment_type = "SINGLE_AZ_1"   # cheapest tier; 64 MB/s minimum
# fsx_throughput_mbps = 64
# enable_fsx = true                    # slice 0 store; off by default (R1 transfer bench needs no FSx)
