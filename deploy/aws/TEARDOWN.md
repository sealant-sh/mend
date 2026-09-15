# AWS capture POC teardown

This is the ordered teardown runbook for the disposable AWS capture POC. It documents destructive
commands; it does not authorize them. Obtain approval immediately before running them. Do not run
steps out of order: application shutdown and capture flush precede MicroVM termination, and PVCs
must be removed while the EKS nodes and EBS CSI controller still exist.

The fixed deployment identity is:

- AWS account: `954648881795`
- AWS region: `eu-central-1`
- EKS cluster and kubeconfig context alias: `mend-capture-poc` / `mend-aws-capture-poc`
- deployment metadata: `~/.config/mend/aws-poc/deployment.json`
- explicit kubeconfig: `~/.config/mend/aws-poc/kubeconfig`
- externally managed MicroVM image: `mend-capture-poc-workspace`, currently version `1.0`
- PlanetScale: organization `mend`, database `aws-poc`, branch `main`

The MicroVM image, Kubernetes application objects, and PlanetScale database are outside the Tofu
state. `tofu destroy` cannot remove them.

## Safety gates

Run AWS and Tofu commands from the repository's deployment shell:

```sh
nix-shell deploy/aws/shell.nix
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1 AWS_PAGER=""
export KUBECONFIG="$HOME/.config/mend/aws-poc/kubeconfig"
METADATA="$HOME/.config/mend/aws-poc/deployment.json"
TF_ROOT="$(realpath deploy/aws/tofu)" # Run from this worktree's root.
```

Before any mutation, stop if any assertion fails:

```sh
test -r "$METADATA"
test -r "$KUBECONFIG"
test "$(stat -c %a "$METADATA")" = 600
test "$(stat -c %a "$KUBECONFIG")" = 600
test "$(jq -r .account "$METADATA")" = 954648881795
test "$(jq -r .region "$METADATA")" = eu-central-1
test "$(jq -r .cluster "$METADATA")" = mend-capture-poc
test "$(jq -r .microvmImage "$METADATA")" = mend-capture-poc-workspace
test "$(aws sts get-caller-identity --query Account --output text)" = 954648881795
test "$(kubectl config current-context)" = mend-aws-capture-poc
kubectl config view --minify
```

Read the displayed AWS principal and Kubernetes server before continuing. Never rely on another
shell's current context. Keep the explicit `KUBECONFIG` exported for every Kubernetes command.

Freeze new session creation. Record the initial inventory and keep it with the teardown evidence:

```sh
deploy/aws/scripts/inventory.sh
aws lambda-microvms list-microvms --region eu-central-1 --output json
aws lambda-microvms list-microvm-images --region eu-central-1 --output json
helm list --all-namespaces --kubeconfig "$KUBECONFIG"
kubectl --kubeconfig "$KUBECONFIG" get pvc,pv --all-namespaces -o wide
```

`list-microvms` is deliberately unfiltered: account-wide enumeration prevents a suspended or
unexpectedly named POC VM from being missed. Attribute every result before terminating anything.

Preserve the repository, `deploy/aws/tofu/terraform.tfstate`, `.terraform.lock.hcl`, the metadata,
and a mode-0600 backup of the state until the final inventory passes. Record a checksum. Do not
move, delete, replace, or use `tofu state rm` to hide a resource that still exists.

## 1. Stop sessions and flush captures through public interfaces

Do not begin with an AWS termination call. First stop every live Mend session using the supported
Mend UI or CLI. First establish the POC's loopback tunnel using the explicit kubeconfig, verify
`/api/health` matches the private session endpoint in `deployment.json`, and authenticate to that
instance. Do not reuse an unrelated CLI server/token configuration. Inspect the targets, then stop
only this POC's sessions:

```sh
MEND_URL=http://localhost:3105 mend sessions
MEND_URL=http://localhost:3105 mend stop --all --project <poc-project>
```

If more than one project was used, stop each one or stop the listed session IDs individually. Wait
until Mend reports every target as stopped.

Then enumerate Sealant workspaces through the public SDK or authenticated control-plane API. With
the Sealant API service privately forwarded from port `4000` to `127.0.0.1:14000`, the relevant
public endpoints are below. Port `3105` is Mend's UI, not the Sealant API.

```text
GET  /v1/workspaces?ownerUserId=<owner>
POST /v1/workspaces/<workspace-id>/capture/flush
POST /v1/workspaces/<workspace-id>/stop
GET  /v1/workspaces/<workspace-id>
```

Both POST bodies are `{"ownerUserId":"<owner>"}`. Prefer the SDK's workspace capture-flush and
`workspace.stop()` methods because `workspace.stop()` waits for terminal `stopped`. For every live
capture-backed workspace:

1. Let the normal harness shutdown run `sealantctl capture flush`.
2. If its result is uncertain, call the public capture-flush endpoint before stopping. It is
   synchronous; require `pending: 0` and `fenced: false` in the response.
3. Call the public stop operation and poll the workspace until it is `stopped` (or another explained
   terminal state). A `202` response only means the stop was accepted.
4. Re-list all owners used by the POC and confirm there are no `queued`, `running`, or `ready`
   workspaces.

Do not print service keys or put them in command history. Read one into an environment variable from
the existing Secret if raw API access is unavoidable, and unset it immediately afterward.

If graceful stop fails, preserve the workspace ID, run ID, record, and failure output. Only after
the public stop path has been attempted and capture state is accounted for may step 2 terminate a
stranded VM.

## 2. Terminate every POC MicroVM and remove the external image

The current external image identity is recorded in metadata. Assert it before using it:

```sh
IMAGE_ARN="$(jq -r .microvm_image_arn "$METADATA")"
IMAGE_VERSION="$(jq -r .microvm_image_version "$METADATA")"
test "$IMAGE_ARN" = "arn:aws:lambda:eu-central-1:954648881795:microvm-image:mend-capture-poc-workspace"
test "$IMAGE_VERSION" = 1.0
```

Enumerate both account-wide and image-specific instances, including suspended instances:

```sh
aws lambda-microvms list-microvms --region eu-central-1 --output json
aws lambda-microvms list-microvms \
  --region eu-central-1 \
  --image-identifier "$IMAGE_ARN" \
  --output json
```

For each positively identified POC instance that survived step 1, terminate it by the identifier
returned above:

```sh
aws lambda-microvms terminate-microvm \
  --region eu-central-1 \
  --microvm-identifier <microvm-identifier>
```

Re-run both listings until every POC instance is `TERMINATED` or absent. Terminated records may
remain visible in the listings. Do not delete the image while any nonterminated instance uses it.

Inventory every version, not only the expected one:

```sh
aws lambda-microvms list-microvm-image-versions \
  --region eu-central-1 \
  --image-identifier "$IMAGE_ARN" \
  --output json
```

Delete version `1.0` and any other version shown, one at a time, then delete the image container:

```sh
aws lambda-microvms delete-microvm-image-version \
  --region eu-central-1 \
  --image-identifier "$IMAGE_ARN" \
  --image-version 1.0

aws lambda-microvms delete-microvm-image \
  --region eu-central-1 \
  --image-identifier "$IMAGE_ARN"
```

Verify both the exact ARN and the name filter are absent. This image was created outside Tofu, so a
successful Tofu destroy does not prove it is gone.

## 3. Remove Kubernetes workloads and PVCs while CSI still works

First record every PVC, PV, StorageClass, and EBS volume handle. Confirm the shared class still has
the expected safety properties:

```sh
kubectl --kubeconfig "$KUBECONFIG" get storageclass mend-gp3 \
  -o jsonpath='{.provisioner}{"\t"}{.reclaimPolicy}{"\t"}{.volumeBindingMode}{"\n"}'
kubectl --kubeconfig "$KUBECONFIG" get pvc --all-namespaces -o wide
kubectl --kubeconfig "$KUBECONFIG" get pv -o json
```

The first command must report:

```text
ebs.csi.aws.com    Delete    WaitForFirstConsumer
```

Stop and remove the Mend Helm release using the exact release and namespace from `helm list -A`.
Remove the standalone Sealant resources using the exact rendered manifest that was applied:

```sh
helm uninstall <release> --namespace <namespace> --wait --kubeconfig "$KUBECONFIG"
kubectl --kubeconfig "$KUBECONFIG" delete -f <exact-rendered-sealant-manifest>
```

Inspect each command's targets before confirming it. Do not delete the EKS cluster, node group, EBS
CSI add-on, CSI IAM role, or `mend-gp3` yet.

List remaining PVCs again. Explicitly delete every POC PVC that uses `mend-gp3`, including retained
claims that a Helm uninstall or manifest deletion left behind:

```sh
kubectl --kubeconfig "$KUBECONFIG" delete pvc <claim> --namespace <namespace>
```

Wait for each PVC and PV to disappear. Then confirm there are no tagged CSI volumes left:

```sh
aws ec2 describe-volumes \
  --region eu-central-1 \
  --filters \
    Name=tag:mend-cluster,Values=mend-capture-poc \
    Name=tag:ebs.csi.aws.com/cluster,Values=true \
  --query 'Volumes[].{Id:VolumeId,State:State,Attachments:Attachments,Tags:Tags}' \
  --output json
```

The result must be `[]`. The CSI driver adds `project=mend`, `environment=aws-capture-poc`, and
`mend-cluster=mend-capture-poc`; require those tags before treating a volume as part of this POC.
Only after all claims, PVs, and tagged volumes are gone should the shared `mend-gp3` StorageClass be
deleted.

A PVC stuck in `Terminating` is a blocker, not permission to continue. Restore or repair the CSI
controller while the cluster exists. Do not strip PV/PVC finalizers first: doing so can orphan the
EBS volume.

## 4. Empty S3 and ECR deliberately

Read the authoritative bucket and repository names from the current Tofu outputs:

```sh
cd "$TF_ROOT"
CAPTURE_BUCKET="$(tofu output -raw capture_bucket)"
ARTIFACT_BUCKET="$(tofu output -raw artifact_bucket)"
ECR_URI="$(tofu output -raw ecr_workspace_repo)"
ECR_REPOSITORY="${ECR_URI#*.amazonaws.com/}"
test "$ECR_REPOSITORY" = mend/capture-workspace
```

### S3

Both buckets currently have `force_destroy=false` and no configured versioning. Confirm the live
state instead of assuming it stayed that way:

```sh
aws s3api get-bucket-versioning --bucket "$CAPTURE_BUCKET" --region eu-central-1
aws s3api get-bucket-versioning --bucket "$ARTIFACT_BUCKET" --region eu-central-1
```

An empty response means versioning has never been enabled. For each bucket:

1. Preserve any evidence required after the POC; emptying the bucket is irreversible.
2. List and abort every incomplete multipart upload.
3. Delete all current objects.
4. If versioning is `Enabled` or `Suspended`, also enumerate and delete **every object version and
   every delete marker**. Process all pages and batches; `delete-objects` accepts at most 1,000 keys
   per request.
5. Repeat the listings until all are empty.

Useful checks and per-item deletion forms are:

```sh
aws s3api list-multipart-uploads --bucket <bucket> --region eu-central-1
aws s3api abort-multipart-upload \
  --bucket <bucket> --key <key> --upload-id <upload-id> --region eu-central-1
aws s3api list-objects-v2 --bucket <bucket> --region eu-central-1 --output json
aws s3api list-object-versions --bucket <bucket> --region eu-central-1 --output json
aws s3api delete-object \
  --bucket <bucket> --key <key> --version-id <version-id> --region eu-central-1
```

`aws s3 rm s3://<bucket> --recursive` removes current objects in an unversioned bucket. It is not
sufficient for a bucket that was ever versioned: delete the `Versions[]` and `DeleteMarkers[]`
entries returned by `list-object-versions`, including a `null` version if present. Re-list after
each batch so concurrent or paginated leftovers cannot be missed. Tofu is expected to refuse
deletion of a nonempty bucket.

### ECR

The repository has immutable tags and `force_delete=false`. Start with the candidate recorded in
metadata, then inventory the whole repository:

```sh
CANDIDATE="$(jq -r .daemon_candidate "$METADATA")"
CANDIDATE_DIGEST="${CANDIDATE#*@}"
aws ecr describe-images \
  --region eu-central-1 \
  --repository-name "$ECR_REPOSITORY" \
  --output json
```

Delete the candidate digest and every other image ID returned by `aws ecr list-images`. Use
`batch-delete-image` in batches of at most 100 image IDs, including untagged child manifests from a
multi-architecture image. The exact candidate deletion is:

```sh
aws ecr batch-delete-image \
  --region eu-central-1 \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids imageDigest="$CANDIDATE_DIGEST"
```

Repeat this inventory until its `imageIds` array is empty:

```sh
aws ecr list-images \
  --region eu-central-1 \
  --repository-name "$ECR_REPOSITORY" \
  --filter tagStatus=ANY \
  --output json
```

Do not continue on a partial `batch-delete-image` response; inspect its `failures` array. Tofu will
not delete this nonempty repository.

## 5. Dispose of PlanetScale separately

PlanetScale is not represented in Tofu. The database is currently `mend/aws-poc`, branch `main`; the
completed `max_connections=50` change stayed on the same M10 cluster and needs no separate AWS
cleanup.

Before deleting anything, inventory the database, API roles, and IP restriction entries:

```sh
pscale database show aws-poc --org mend --format json
pscale role list aws-poc main --org mend --format json
pscale api organizations/mend/databases/aws-poc/cidrs --org mend --format json
```

Cross-check the IP restriction ID against `.planetscale_private_only_rule.id` in `deployment.json`.
Current POC role names include `mend-app`, `sealant-app`, `mend-aws-deploy`, and `mend-bootstrap`;
trust the live list and the local mode-0600 role metadata rather than copying IDs from this
document.

For complete disposal, use the supported PlanetScale database delete command and confirm the
organization and database at its prompt:

```sh
pscale database delete aws-poc --org mend
```

Deleting the database removes its branches, roles, and IP restrictions. Verify `database show` now
returns not found and that `aws-poc` is absent from the organization database list. Do not delete
the IP restriction first during a full database disposal: that would briefly broaden connectivity.

If the database must be retained instead, it is not a complete POC teardown and PlanetScale billing
continues. Remove only confirmed POC API roles with
`pscale role delete aws-poc main <role-id> --org mend`. Keep the private-only IP restriction unless
the operator explicitly approves a replacement access policy. Deleting the final restriction would
reopen public connectivity for any remaining credentials.

Re-list roles and restrictions afterward. If a role owns objects, inspect those objects and use the
CLI's explicit `--successor` option; do not guess or silently force reassignment.

## 6. Create, review, and apply a saved Tofu destroy plan

Only now should Tofu remove the AWS foundations. Return to the original state directory and confirm
that its path matches `.tofuState` in the deployment metadata:

```sh
cd "$TF_ROOT"
test "$(pwd)/terraform.tfstate" = "$(jq -r .tofuState "$METADATA")"
tofu state list
```

Create a saved destroy plan under the private deployment directory, render it to text, and review
both the resource addresses and summary:

```sh
DESTROY_PLAN="$HOME/.config/mend/aws-poc/tofu-destroy.tfplan"
umask 077
tofu plan -destroy -input=false -var-file=poc.tfvars -out="$DESTROY_PLAN"
tofu show -no-color "$DESTROY_PLAN" > "$DESTROY_PLAN.txt"
less "$DESTROY_PLAN.txt"
```

Require an understood deletion for every remaining state object. Investigate any create, unexpected
replacement, wrong account/region, missing foundation, or dependency error. A destroy plan does not
include the external MicroVM image, Kubernetes objects, or PlanetScale database.

After approval, apply that exact saved plan:

```sh
tofu apply "$DESTROY_PLAN"
```

Do not substitute an unsaved `tofu destroy -auto-approve`. If apply is interrupted or fails, keep
the state and failed plan as evidence, inventory again, fix only the specific blocker, then create
and review a **new** saved destroy plan. Never reuse a plan after state or remote resources changed.

## Partial apply and interrupted teardown recovery

A partial deployment or teardown must be reconciled from observed state, not from the happy-path
sequence:

1. Re-run the account, region, metadata, and explicit-kubeconfig gates.
2. Run `tofu state list`, the unfiltered MicroVM/image listings, service-specific S3/ECR queries,
   and tagged-resource inventory. Do not assume a missing Tofu output means the remote resource is
   gone; recover names from preserved metadata, `tofu state show`, or the remote service inventory.
3. If EKS still answers, finish application and PVC deletion before allowing Tofu to remove the node
   group or CSI add-on.
4. If EKS is gone but a PV record or inventory identifies an EBS volume, describe it directly.
   Delete it manually only when all expected POC/CSI tags match, it is in account `954648881795` and
   region `eu-central-1`, and it has no attachment. An attached volume requires investigation; do
   not force detach a volume from an unidentified instance.
5. If the cluster exists but CSI was removed, restore the pinned CSI add-on and its IAM role long
   enough to complete PVC deletion. Prefer restoring the controller over removing finalizers.
6. If Tofu reports a resource already absent, refresh and review a new destroy plan. Do not use
   state removal to conceal an object that may still incur cost.
7. A nonempty S3 bucket or ECR repository is an intentional deletion barrier. Finish the relevant
   version/delete-marker, multipart-upload, or image cleanup and plan again.

## Final inventory and evidence-retention gate

After Tofu apply, run service-specific checks. Expect no live POC resources. Historical `TERMINATED`
MicroVM records may still appear and do not mean an executor is running:

```sh
aws lambda-microvms list-microvms --region eu-central-1 --output json
aws lambda-microvms list-microvm-images \
  --region eu-central-1 \
  --name-filter mend-capture-poc-workspace \
  --output json
aws ec2 describe-volumes \
  --region eu-central-1 \
  --filters Name=tag:mend-cluster,Values=mend-capture-poc \
  --output json
aws resourcegroupstaggingapi get-resources \
  --region eu-central-1 \
  --tag-filters Key=project,Values=mend Key=environment,Values=aws-capture-poc \
  --output json
aws ecr describe-repositories \
  --region eu-central-1 \
  --repository-names mend/capture-workspace
aws eks describe-cluster --region eu-central-1 --name mend-capture-poc
pscale database show aws-poc --org mend --format json
tofu state list
```

The ECR, EKS, and PlanetScale lookups should return not found; distinguish that from authentication,
wrong-account, and network errors. Resource tagging can lag, so retry a stale tagged result and
confirm it with its owning service. Also verify the two recorded S3 bucket names no longer appear in
`list-buckets`.

Keep the source checkout, final `terraform.tfstate`, saved plans, metadata, checksums, and teardown
logs until this inventory is reviewed. Keep secrets mode `0600` and out of logs. Only after cleanup
is verified may the private POC metadata and credential files be securely discarded.
