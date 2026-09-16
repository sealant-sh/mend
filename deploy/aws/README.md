# AWS capture POC

Mend on EKS, PlanetScale Postgres over PrivateLink, authoritative captures in S3, and disposable
Lambda MicroVM executors. No FSx and no public application ingress. Account `954648881795`, region
`eu-central-1`; the destroyed benchmark stack is not reused.

See the [capture-store ADR](../../docs/adr/0002-session-capture-store.md),
[workbench plan](../../MEND-AGENT-WORKBENCH-PLAN.md), [Sealant manifests](kubernetes/README.md), and
[teardown procedure](TEARDOWN.md).

## Private access update — 2026-09-16 UTC

Owner-only Tailscale HTTPS is installed at <https://mend-access.tailc79e49.ts.net>. Connect
Tailscale and use the existing Mend login. See the
[deployment record](../../docs/operations/aws-access-deployment.md) for versions, restrictions,
verification, remaining acceptance and rollback notes. This does not make Mend public-ready or
enable teammate access. The original infrastructure observations below predate this access change.

## Application and Docker update

As of 2026-09-16 UTC, Mend API/web **0.28.0** and Sealant API/worker **0.33.0** are now deployed
with digest-pinned images. Fresh Docker-required workspaces select the separately retained
`mend-capture-poc-workspace-docker` image, version **1.0**. The ordinary image is unchanged. Both
application IAM policies now allow that exact Docker image ARN; no actions, role trust or other
resource grants changed.

One shell-only Mend session passed Docker info, build, run, Compose, root-owned bind writes, nested
DNS and closed Docker TCP ports. CLI and Mend planned-stop capture flushes reported nothing pending
and no fence. The test VM was independently confirmed terminated, test data was removed, and the
normal **3600-second** limit was restored. No new inference calls were recorded. A redundant SDK
flush ran after normal VM termination; the checker's later post-stop file read was not reached. See
the [Docker service record](../../docs/operations/aws-docker-service.md) for that qualification,
resource limits and remaining gaps.

The upgrade preserved existing Helm values, owner-only HTTPS, storage, networking and projects. Its
private evidence and rollback inputs are under `~/.config/mend/aws-poc/upgrade-0.28.0/`. Do not
reconstruct this live release with `scripts/render-mend.py`: it still defaults to Mend 0.27.5 and a
localhost origin. Use the saved live values and the released chart for subsequent upgrades.

## Original deployment observations, 2026-09-15 UTC

- EKS `mend-capture-poc`: one healthy ARM64 `m7g.large`, desired/min/max **1**. All four managed
  add-ons are healthy. No autoscaling or executor EC2 fleet.
- Mend API/web `0.27.5`, Sealant API/worker `0.32.0`, and Zot are deployed. Mend's health endpoint
  answers through a loopback-only port-forward. The internal session NLB has a healthy NodePort
  target. Encrypted gp3 claims are bound: Mend 20 GiB, registry 10 GiB.
- PlanetScale `mend/aws-poc/main` remains **Metal M-10**. Direct port **5432** is intentional: both
  applications use `LISTEN/NOTIFY`. Its default 25-connection limit caused PostgreSQL `53300` during
  Mend startup. Setting `pgconf.max_connections=50` through PlanetScale's supported API resolved
  startup without changing the SKU, replicas, or pricing. This setting is outside ToFu.
- Private DNS resolves to the endpoint's `10.42.*` addresses. `psql` with `sslmode=verify-full`
  connected using TLS 1.3. PlanetScale terminates that TLS at its proxy; `pg_stat_ssl` describes the
  provider's backend hop, not this client connection.
- Separate logical databases `mend` and `sealant_control_plane`, each with a dedicated application
  role. Stable `postgres` owns the databases; each application has connect/create rights only in its
  database and create/usage on its public schema. Neither application inherits `postgres`,
  `pg_read_all_data`, or `pg_write_all_data`.
- A global PlanetScale RFC1918-only IP rule blocks public connections, following its
  [PrivateLink restriction guidance](https://planetscale.com/docs/postgres/connecting/ip-restrictions).
  A real public-endpoint connection with valid credentials was rejected with `28000`.
- The fixed MicroVM image `mend-capture-poc-workspace`, version **1.0**, reached `CREATED`. **This
  is a private platform candidate**, not the unmodified public daemon release; see below.
- **Capture/replacement acceptance passed.** The first shell exited 0 with checkpoint sequence 28. A
  different workspace joined the same captured worktree, verified the exact file contents, ran
  `sealantctl --socket /run/sealant/control.sock capture flush`, and exited 0 with checkpoint
  sequence 35. Both AWS MicroVMs are `TERMINATED`; all control-plane pods remain healthy. Evidence
  is in `~/.config/mend/aws-poc/acceptance.json`. This tests a new shell conversation on the same
  worktree, not native Codex/Claude conversation resume, and uses the private candidate.

Live IDs and non-secret provenance are in `~/.config/mend/aws-poc/deployment.json`. Credentials,
application identity, explicit kubeconfig, rendered manifests and smoke-account state live beside it
with restrictive permissions, outside Git. Local ToFu state remains in `deploy/aws/tofu/`. Both
locations are needed for an orderly handoff and teardown; do not discard them.

## Footprint and boundaries

- VPC `10.42.0.0/16`, two AZs, private `/20` subnets, one NAT in `eu-central-1a`, and an S3 gateway
  endpoint. The worker stays in that AZ for gp3 reattachment and to avoid cross-AZ NAT charges.
- EKS 1.35 uses standard support. Its public control-plane endpoint admits only the operator's
  configured CIDR; private access is also enabled. No SSH; IMDSv2, hop limit 1; encrypted 40 GiB
  node boot disk. VPC CNI network-policy enforcement is enabled.
- PrivateLink has two endpoint ENIs. Its SG permits PostgreSQL only from the EKS workload SG. The
  MicroVM connector has a different SG and no database grant.
- Internal TCP NLB `3106 → 31006` admits only the MicroVM connector. The session channel is **HTTP
  inside the private VPC, not TLS**. Session tokens protect its application protocol.
- Separate IRSA roles for Mend, Sealant API/worker, CNI and EBS CSI. The node has no capture or
  MicroVM management privileges. Executors get per-session tokens and presigned S3 URLs, not
  database credentials or a bucket-wide IAM role.
- Capture and build-artifact buckets block public access and require TLS, use SSE-S3 and abort
  incomplete multipart uploads after one day. **No versioning or object expiry**; both have
  `force_destroy=false`. Capture retention belongs to the application.
- Immutable-tag ECR repository; MicroVM build, connector and runtime-log roles; 14-day log groups.
  MicroVM sessions are configured with a 3600-second maximum. Keep project standby counts at zero.
- **$100 account-wide monthly budget**, actual alerts at $25/$75 and forecast alert at $100. It
  includes unrelated AWS usage, excludes PlanetScale billing, and is **not a spending cap**.

Tags are `project=mend`, `environment=aws-capture-poc`; CSI volumes also carry the cluster tag. The
AWS provider cannot tag the MicroVM connector. The inventory script includes separate runtime
resources. This is not HA: one worker/NAT, one CoreDNS/CSI controller, and non-surge node updates.

## Provision and render

Use `nix-shell deploy/aws/shell.nix` for AWS CLI, OpenTofu, kubectl, Helm and Python/boto3. The
provider lockfile pins AWS provider 6.64.0; do not casually run `init -upgrade`.

```sh
aws sts get-caller-identity # must be 954648881795
umask 077
cd deploy/aws/tofu
# On a NEW deployment only: copy example.tfvars to poc.tfvars and set CIDR/email.
# Never overwrite the live inputs or create a second state for these resource names.
tofu init -input=false -lockfile=readonly
tofu fmt -check && tofu validate
tofu plan -input=false -var-file=poc.tfvars -out=poc.tfplan
# Inspect and obtain provisioning approval before applying a new plan.
tofu apply -input=false poc.tfplan
tofu output -json > outputs.json
```

State and plans are ignored, not encrypted. Keep them on encrypted storage; use one operator at a
time. Do not put credentials in tfvars or either application bucket as a makeshift state backend.
Changing the Kubernetes version also requires matching node release and add-on versions.

From the worktree root, with the operator's explicit kubeconfig:

```sh
export KUBECONFIG="$HOME/.config/mend/aws-poc/kubeconfig"
aws eks update-kubeconfig --name mend-capture-poc --alias mend-aws-capture-poc \
  --kubeconfig "$KUBECONFIG"
kubectl get nodes
# Wait for CoreDNS and CSI to exist and finish their rollouts before application setup.
python3 deploy/aws/scripts/bootstrap-databases.py
# Optional read-only SQL diagnostics, using an ephemeral pod:
python3 deploy/aws/scripts/bootstrap-databases.py --inspect

OUT="$HOME/.config/mend/aws-poc/rendered"
mkdir -p "$OUT"
python3 deploy/aws/scripts/render-mend.py foundations < deploy/aws/tofu/outputs.json > "$OUT/foundations.json"
python3 deploy/aws/scripts/render-mend.py values < deploy/aws/tofu/outputs.json > "$OUT/mend-values.json"
python3 deploy/aws/kubernetes/render.py --outputs deploy/aws/tofu/outputs.json \
  --microvm-image-arn arn:aws:lambda:eu-central-1:954648881795:microvm-image:mend-capture-poc-workspace \
  --microvm-image-version 1.0 --output "$OUT/sealant.yaml"
kubectl apply -f "$OUT/foundations.json"
kubectl apply -f "$OUT/sealant.yaml"
helm upgrade --install mend deploy/helm/mend -n mend -f "$OUT/mend-values.json" --wait --timeout 6m
kubectl -n mend port-forward --address 127.0.0.1 svc/mend-web 3105:3105
```

The bootstrap script expects mode-0600 `bootstrap-role.json`, `mend-app-role.json`, and
`sealant-app-role.json` from PlanetScale's role API in the private config directory. Its temporary
admin role must still be valid. It refuses broadly privileged application roles, mounts the
operator's public CA bundle, and removes its bootstrap pod/Secret/ConfigMap afterward. It never
prints passwords. Re-running preserves the application identity; do not rotate it accidentally. The
shared StorageClass and Mend service account belong to `render-mend.py`, not the Sealant renderer.
**Do not set `SEALANT_K8S_NAMESPACE`**: only the build namespace is configured.

## Candidate image and acceptance

Docker capability work uses a separate opt-in image and does not change this deployed default. See
the [AWS Docker service runbook](../../docs/operations/aws-docker-service.md) for the released
configuration, privilege model, source-selection options and acceptance limits. Source pins Sealant
0.33.0 for the SDK, packaged services, AWS control-plane templates and MicroVM recipe; the private
deployment now runs that release. The original ordinary-image acceptance below remains a separate
observation.

The official Core recipe at `abe4d6c7258a5d6b479b72162de368c45953d9ee` reproduces a packaging
failure: `sealantd:0.15.2` contains the daemon and socat but no `sealantctl`. The CLI is required
for suspend and terminate capture flushes. Sealant 0.33.0 still uses that daemon release, so the
packaging gap remains. The hook has not been removed or bypassed.

`scripts/build-sealantctl-pod.json` builds the CLI natively on ARM64 from daemon revision
`5173e4920d44d5663b6a4fec4606ab58e7607ca1`, with Rust **1.96.1** explicitly selected (the
repository's `stable` override would otherwise select a different toolchain). Copy the binary out,
then remove the temporary pod. `scripts/sealantd-candidate.Dockerfile` adds only that CLI to the
pinned public daemon image. The private candidate digest is recorded in `deployment.json`.

Set `SEALANTD_IMAGE` to the candidate when running `scripts/build-workspace-image.sh`. The script
defaults to the official Core 0.33.0 recipe at `17a23ffcbe47bb16f5b9516c7b8bbfa89c9a61d3`, adds
pinned pnpm/Codex/Claude CLI versions, and uses the scoped build role and artifact bucket. The fixed
AWS image is **not** the OCI output of a workspace-profile BuildKit job. The original ordinary-image
acceptance used `node:24-bookworm` (its custom-base contract requires Git, Node and npm), no extra
packages and no Docker service. A bare Amazon Linux profile failed that prerequisite before any VM
launch. The actual VM still runs the separately built Amazon Linux image: Debian or arbitrary
profile/image customization is **not** established by this deployment.

With the loopback tunnel running, `scripts/session-smoke.py` provides explicit `provision`,
`launch`, `restore`, `status` and `stop` phases. It uses public Mend HTTP routes, a dedicated test
account and a public tiny repository. The shell writes `aws-capture-proof.txt`; it invokes no paid
inference and pushes nothing. Credentials and IDs stay in the private config directory. Check the
record, capture object/pointer and restored file before claiming persistence. Stop executors after
testing.

Capture objects can contain harness login material. SSE-S3 does not hide it from authorized bucket
readers. Treat reader grants and backups accordingly. Follow [TEARDOWN.md](TEARDOWN.md) to stop
billing; deleting this checkout or closing the UI tunnel does not delete cloud resources.
