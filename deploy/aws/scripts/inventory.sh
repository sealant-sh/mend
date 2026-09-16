#!/usr/bin/env bash
# Read-only teardown inventory. Run inside deploy/aws/shell.nix.
set -euo pipefail
export AWS_REGION=eu-central-1 AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" == 954648881795 ]] || { echo 'Wrong AWS account' >&2; exit 1; }
IMAGE="arn:aws:lambda:$AWS_REGION:$ACCOUNT:microvm-image:mend-capture-poc-workspace"
echo 'Tagged infrastructure and CSI volumes:'
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=project,Values=mend Key=environment,Values=aws-capture-poc \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
echo 'Workspace MicroVMs, including suspended instances:'
aws lambda-microvms list-microvms --image-identifier "$IMAGE" --output json
echo 'All MicroVM images (confirm the exact POC name before deleting):'
aws lambda-microvms list-microvm-images --output json
echo 'PlanetScale is separate: organization mend, database aws-poc, branch main.'
echo 'Local state: deploy/aws/tofu/terraform.tfstate. Keep it until verified teardown.'
echo 'Private credentials: ~/.config/mend/aws-poc. Do not include them in bug reports.'
