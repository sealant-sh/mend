# Mend on AWS · MicroVM POC

Slice 0 of the hosted-Mend experiment: can FSx for OpenZFS be the authoritative git store while
Lambda MicroVMs act as cheap, disposable executors? This directory stands up the network and the
store, builds one benchmark MicroVM image, runs the same git and install workload on FSx and on the
VM's local disk, and reports the difference. No Mend code runs yet; the control plane (EKS) and the
Sealant `microvm` runtime adapter are later slices. The full design lives in the Obsidian note
`Mend AWS hosted POC`.

Everything is tagged `project=mend`, `environment=aws-microvm-poc`, sits in one AZ of
`eu-central-1`, and goes away with `tofu destroy`.

## Layout

| Path             | What                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `shell.nix`      | The tools: awscli2, opentofu, kubectl, helm, jq, zip, python3+boto3. Nothing global.     |
| `tofu/`          | VPC, subnets, NAT, S3 gateway endpoint, FSx OpenZFS (behind `enable_fsx`), security      |
|                  | groups, IAM roles, the MicroVM VPC egress connector, artifact bucket, ECR repo, log      |
|                  | group, budget alarm.                                                                     |
| `microvm-bench/` | The bench image: Dockerfile, lifecycle-hook server (`hooks.mjs`), git benchmark          |
|                  | (`bench.sh`), bucket transfer benchmark (`bench-transfer.sh`, decision R1).              |
| `scripts/`       | Build the image, run a bench VM, run the transfer bench, terminate VMs. Inputs come from |
|                  | `tofu output`.                                                                           |
| `results/`       | Benchmark JSON and logs per run (gitignored); `R1-*.md` summaries are committed.         |

## Run it

```sh
nix-shell deploy/aws/shell.nix
aws configure sso            # or export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
aws sts get-caller-identity  # sanity

cd deploy/aws/tofu
cp example.tfvars poc.tfvars && $EDITOR poc.tfvars
tofu init
tofu apply -var-file=poc.tfvars          # ~3 min without FSx; enable_fsx = true adds ~15 min

cd ..
./scripts/01-build-image.sh              # zip → S3 → CreateMicrovmImage, waits for CREATED
./scripts/02-run-bench.sh                # one VM, mounts FSx, runs the bench, prints results
./scripts/02-run-bench.sh https://github.com/some/large-repo.git 3 1   # large repo + pnpm install
./scripts/04-terminate.sh                # stop paying for VMs
./scripts/09-run-transfer.sh connector   # R1: 1 GiB S3 GET/PUT over presigned URLs, VM terminated at the end
./scripts/09-run-transfer.sh default     # same, without the egress connector
```

The transfer bench needs no FSx: apply with `enable_fsx = false` (the default). Results and the
2026-09-12 verdict are in `results/R1-transfer-2026-09-12.md`.

Concurrency test: run `02-run-bench.sh` three times in parallel from three shells. They share the
export; each bench writes under its own `bench-<id>` directory and leaves a JSON in `/mend/_bench`.

Tear down: `./scripts/04-terminate.sh`, delete the MicroVM image
(`aws lambda-microvms delete-microvm-image --image-identifier <arn>`), then `tofu destroy`.

## What the bench measures

For each of FSx (NFS 4.1, `nconnect=8`, 1 MiB rsize/wsize, `hard`) and local disk: bare clone,
worktree add, cold and warm `git status`, status after one modified file, diff, add, commit, switch,
log, a second worktree add, no-op fetch, count-objects, repack, gc, and optionally `pnpm install`
plus a status with `node_modules` present. Three samples per operation by default. The session start
number to record separately is the `RUNNING after N s` line the run script prints: it includes the
`/run` hook, which mounts and validates FSx before the VM is usable.

## Decisions baked in here

- **FSx export**: `rw,crossmnt,all_squash,anonuid=1000,anongid=1000`. Every NFS writer maps to uid
  1000, which ends the uid split between the engine (uid 1000) and root inside workspaces. The API
  accepts exports(5) options as opaque strings; confirm the squash took effect by reading `uid` in
  the hooks log after the first mount.
- **No fallback to local disk.** If the mount fails, `/run` answers 500 and the VM start fails.
- **Idle policy** on the bench VM is generous (1 h) so a slow bench is not suspended mid-run. The
  real adapter turns idle suspension off and suspends explicitly when a session settles.
- **Execution role** grants logs only. Code inside the VM is treated as hostile.
- **Image via CLI, not OpenTofu.** The provider's `aws_lambdamicrovms_image` has no `hooks`,
  `resources` or `logging` arguments yet; the connector is in OpenTofu.
