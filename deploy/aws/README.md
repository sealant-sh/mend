# Mend on AWS

Nothing runs on AWS today. The EKS control plane is off (`cluster_enabled = false`), and the single
EC2 instance that served alpha.mend.run was torn down when alpha moved to the self-hosted box (see
[preview builds](../../docs/operations/preview-builds.md#the-box)). This directory is what it takes
to stand Mend up on AWS again.

The stack is Mend on EKS or on one EC2 instance, PlanetScale Postgres over PrivateLink, captures in
S3, and disposable Lambda MicroVM executors. No FSx. Account `954648881795`, region `eu-central-1`.
The MicroVM images, the PlanetScale database and any Tailscale devices are outside the OpenTofu
state; check what is left of them before reusing a name.

See the [capture store ADR](../../docs/adr/0002-session-capture-store.md),
[product statement](../../PRODUCT.md), [Sealant manifests](kubernetes/README.md),
[costs](poc-cost-plans.md), [what stops real high availability](issues-for-real-ha.md) and the
[teardown procedure](TEARDOWN.md).

## Two control planes, one stack

The stack runs Mend's control plane one of two ways, and sessions run in Lambda MicroVMs either way.

|                 | Setting            | Default | What it adds                                                                                                                |
| --------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| EKS cluster     | `cluster_enabled`  | `true`  | The cluster, node group and add-ons, the EBS CSI role, one IAM role per service account, the VPC-only session load balancer |
| Single instance | `instance_enabled` | `false` | One ARM64 instance with an Elastic IP and a data volume, one instance role                                                  |

The two are independent: either, both or neither. Everything else is shared and never gated: the VPC
and NAT gateway, both buckets, the PlanetScale endpoint, the MicroVM connector and the MicroVM build
and execution roles. Turning a control plane off removes only what its row names. Before
`cluster_enabled = false` on a cluster that has run, follow [`TEARDOWN.md`](TEARDOWN.md) steps 1 to
3: a PVC deleted after the EBS CSI controller is gone leaves its volume behind.

## Prerequisites

- An AWS identity with administrative rights in account `954648881795`. A root-console identity is
  not an EKS access grant.
- `nix-shell deploy/aws/shell.nix` for the AWS CLI, OpenTofu, kubectl, Helm and Python with boto3.
  The provider lockfile pins the AWS provider; do not casually run `init -upgrade`.
- `deploy/aws/tofu/poc.tfvars`, copied from [`example.tfvars`](tofu/example.tfvars), with the
  operator's CIDR (the only address the EKS API admits), the budget email, and which control planes
  to run. Never put AWS or database credentials in it.
- A PlanetScale organization with a Postgres database for Mend and Sealant, and its role API. The
  bootstrap script reads mode-0600 `bootstrap-role.json`, `mend-app-role.json` and
  `sealant-app-role.json` from `~/.config/mend/aws-poc/`.
- For the single instance: a DNS name you control, as a DNS-only A record.
- For owner-only access to the cluster: a tailnet you administer (below).

Keep the private configuration directory, `~/.config/mend/aws-poc/`, and the OpenTofu state in
`deploy/aws/tofu/` together. State and plans are ignored by Git and not encrypted: keep them on
encrypted storage, use one operator at a time, and do not use either application bucket as a state
backend.

## Test offline first

```sh
node --test scripts/aws-tofu.test.mjs
pnpm test:aws-shell
```

The first needs OpenTofu compatible with `tofu/versions.tf` (CI installs 1.12.0;
`MEND_TEST_TOFU_BINARY` picks a local binary). It copies the configuration and provider lock into a
scratch directory, initialises without a backend, and plans all four cluster and instance settings
against a mocked AWS provider. It compares the planned resource addresses with independent cluster,
instance and shared inventories. It passes no credentials and applies nothing, so it proves resource
gating, not live AWS permissions. The second exercises `kubernetes/smoke.sh` and
`scripts/build-workspace-image.sh` with local command fixtures, with no AWS or network calls. CI
runs both.

## Provision

```sh
aws sts get-caller-identity # must be 954648881795
umask 077
cd deploy/aws/tofu
tofu init -input=false -lockfile=readonly
tofu fmt -check && tofu validate
tofu plan -input=false -var-file=poc.tfvars -out=poc.tfplan
# Inspect the plan and get approval before applying it.
tofu apply -input=false poc.tfplan
tofu output -json > outputs.json
```

Never create a second state for these resource names. Changing the Kubernetes version also needs
matching node release and add-on versions.

## On EKS

From the repository root, with an explicit kubeconfig:

```sh
export KUBECONFIG="$HOME/.config/mend/aws-poc/kubeconfig"
aws eks update-kubeconfig --name mend-capture-poc --alias mend-aws-capture-poc \
  --kubeconfig "$KUBECONFIG"
kubectl get nodes
# Wait for CoreDNS and CSI to exist and finish their rollouts before application setup.
python3 deploy/aws/scripts/bootstrap-databases.py
# Optional read-only SQL diagnostics, through an ephemeral pod:
python3 deploy/aws/scripts/bootstrap-databases.py --inspect

OUT="$HOME/.config/mend/aws-poc/rendered"
mkdir -p "$OUT"
python3 deploy/aws/scripts/render-mend.py foundations < deploy/aws/tofu/outputs.json > "$OUT/foundations.json"
python3 deploy/aws/scripts/render-mend.py values < deploy/aws/tofu/outputs.json > "$OUT/mend-values.json"
python3 deploy/aws/kubernetes/render.py --outputs deploy/aws/tofu/outputs.json \
  --microvm-image-arn <microvm image arn> --microvm-image-version <version> --output "$OUT/sealant.yaml"
kubectl apply -f "$OUT/foundations.json"
kubectl apply -f "$OUT/sealant.yaml"
helm upgrade --install mend deploy/helm/mend -n mend -f "$OUT/mend-values.json" --wait --timeout 6m
kubectl -n mend port-forward --address 127.0.0.1 svc/mend-web 3105:3105
```

The bootstrap script needs its temporary admin role still valid. It refuses broadly privileged
application roles, mounts the operator's public CA bundle, removes its pod, Secret and ConfigMap
afterwards, and never prints passwords. Running it again keeps the application identity. The shared
StorageClass and Mend's service account belong to `render-mend.py`, not the Sealant renderer. Do not
set `SEALANT_K8S_NAMESPACE`: only the build namespace is configured. `render-mend.py`'s defaults
(Mend version, a localhost origin) are old: set the version and origins in the values before
installing. [`kubernetes/README.md`](kubernetes/README.md) covers the Sealant manifests.

PlanetScale's default 25-connection limit is too few for both applications at start (Postgres error
`53300`); the earlier deployment set `pgconf.max_connections=50` through PlanetScale's API, outside
OpenTofu. Both applications use `LISTEN/NOTIFY`, so they connect on the direct port 5432. A global
RFC1918-only IP rule on PlanetScale keeps the public endpoint closed, following its
[PrivateLink guidance](https://planetscale.com/docs/postgres/connecting/ip-restrictions).

`scripts/session-smoke.py` drives one session through public Mend HTTP routes, with explicit
`provision`, `launch`, `restore`, `status` and `stop` phases, a dedicated test account and a small
public repository. It runs no paid inference and pushes nothing. Check the record, the capture
object and pointer, and the restored file before claiming persistence, and stop executors after.

## On one instance

`tofu/instance.tf` puts the control plane on one EC2 instance, with `instance_enabled = true`. It
runs [`deploy/docker/compose.aws.yaml`](../docker/compose.aws.yaml) behind the Caddy edge and reuses
the stack's VPC, capture bucket, PlanetScale endpoint and MicroVM connector. Sessions stay in Lambda
MicroVMs. No Docker socket is mounted and the Docker runtime is off, so no tenant code runs on the
host.

What is published: 80 and 443 to the edge, 2222 to Mend's workspace SSH gateway, and 3106 to the
MicroVM connector's security group only. There is no host sshd on the Internet. Administration is
SSM Session Manager, and Mend's own port stays on loopback.

1. `tofu apply` with `instance_enabled = true`. Create a DNS-only A record for `instance_hostname`
   at `instance_public_ip`. A proxied record breaks workspace SSH and terminates TLS before the
   edge.
2. Create fresh `mend` and `sealant_control_plane` databases and roles on PlanetScale, as
   `scripts/bootstrap-databases.py` does for the cluster. To reuse databases that have run, empty
   them as each application's own role: drop the schemas it made (`pgboss`, `drizzle`) and every
   object it owns in `public`. `DROP OWNED` also revokes the role's grants, so do not use it.
3. Put `compose.aws.yaml`, `compose.edge.yaml`, `compose.logs.aws.yaml`, `Caddyfile` and a `.env`
   from [`aws.env.example`](../docker/aws.env.example) in `/opt/mend`, mode 600, owned by root. The
   `.env` holds the only secrets; nothing secret is in OpenTofu state or user data. Do not send it
   with `aws ssm send-command`: a command's input and output stay in the account's SSM history.
   Forward the instance's sshd over Session Manager and copy the files through that, then remove the
   key. Take `microvm_artifact_prefix` and `microvm_image_name_prefix` from `tofu output` as they
   are: the instance role and the build role are granted exactly those.
4. First boot with `MEND_TENANCY=single`, `MEND_EXPOSURE=private` and
   `MEND_ALLOWED_ORIGINS=["http://localhost:3105"]`, **and start `mend` only**:
   `docker compose -f compose.aws.yaml up -d mend`. Both gates count the operator account, so
   neither `multi` nor `public` may start on an empty database. Registration is open until that
   account exists, and the edge would serve the public name the moment it starts, putting the name
   in the public certificate logs. So the edge stays down until step 6.
5. Run `instance_first_account_tunnel` and create the first account at `http://localhost:3105`. It
   becomes the owner and the operator, and registration closes (`/api/instance` answers
   `"registration":"closed"`). The extra origin in step 4 is what lets sign-up accept the tunnel.
   Session Manager closes an idle forward, so start it when you are ready to register.
6. Remove `MEND_ALLOWED_ORIGINS`, set `MEND_TENANCY=multi` and `MEND_EXPOSURE=public`, and bring
   everything up:
   `docker compose -f compose.aws.yaml -f compose.edge.yaml -f compose.logs.aws.yaml up -d`. The
   last file sends the server's and the edge's logs to CloudWatch, `/mend/<name>/containers`, so a
   restart keeps them. Read `mend operator gate` and `mend operator exposure`.
7. From outside the VPC, check TLS and the redirect on the public name, that a sign-up without an
   invitation is refused, that only 80, 443 and 2222 answer at the public address, and that an
   application role cannot connect to PlanetScale's public endpoint. Only then name
   `core-private,edge-tls` in `MEND_EXPOSURE_DECLARED` and `up -d` again. The `reassessment` item
   stays open until someone records a reassessment of the running release.

The instance role holds the three policies the cluster keeps on separate service accounts, because
Mend and Sealant's API and worker run in one container here. The worker's policy covers running
MicroVMs and building, reading and deleting images under the stack's name prefix.
`CreateMicrovmImage`, `ListMicrovmImages` and `TagResource` authorise against no resource, so those
are granted on `*`; the name prefix in the worker's configuration bounds what it may create.
`GetMicrovmImage` and `DeleteMicrovmImage` are granted on the image name pattern. The metadata hop
limit is 2 so the container can use the role; user data drops the edge network's path to the
metadata address.

Docker's data root is a separate encrypted volume with daily snapshots, seven kept, and
`prevent_destroy`. It holds the store, the SSH host key and the edge's certificates. PlanetScale and
S3 hold the rest.

## Workspace images

Every Sealant runtime builds the image for a project's recipe itself, and MicroVM does it with AWS's
managed image build. The worker uploads a build context (a Containerfile and the in-VM agent's
scripts, no binaries and no secrets) to `sealant/workspace-images/` in the artifacts bucket, the
managed build runs it, and the worker deletes the context. One recipe is one image,
`<name>-ws-<plan hash>`, shared by every workspace with that recipe. Sealant deletes the ones
nothing uses and refuses to build past 50. A first session on a new recipe waits for the build,
about three minutes when measured on this account.

A recipe step runs as root and can read the build role's credentials, so that role can read that one
prefix and write its build log, and nothing else. A step cannot reach the VPC, the database or the
capture bucket. The role is one for the whole deployment, so a step of one organization's recipe
could read another's build context if it could guess a random key; a context holds no secrets.

Docker inside a session ships on every image family since Sealant 0.36.1, so no separate Docker
workspace image is needed.

## Access and HTTPS

The single instance is public behind the Caddy edge, as above. The EKS control plane has no public
application ingress; the earlier deployment reached it in two ways.

**A loopback port-forward**,
`kubectl -n mend port-forward --address 127.0.0.1 svc/mend-web 3105:3105`. It ends when its web pod
is replaced. HTTPS cookie sessions do not work over it; use the CLI's bearer login.

**Owner-only HTTPS through Tailscale.** The Tailscale Kubernetes operator ran a standalone L7
Ingress, `mend/mend-access`, forwarding only to `mend-web:3105`. The operator registered its proxy
as a tailnet device, and MagicDNS resolved `mend-access.<tailnet>.ts.net` to it for connected
clients. With HTTPS certificates enabled in the tailnet, Tailscale Serve in the proxy obtained a
Let's Encrypt certificate through a DNS-01 challenge Tailscale answers under `ts.net`, and renews it
itself. No public inbound port, ACM certificate or cert-manager was needed. The hostname is public
in certificate transparency logs; Funnel stayed off. TLS ends at the proxy, and the hop to
`mend-web` is plain HTTP inside the cluster, restricted by NetworkPolicy. Mend's `APP_URL` was the
`ts.net` origin.

To set it up again:

1. Get the owner's approval for the tailnet, a neutral hostname (the certificate discloses it), the
   member list and billing.
2. Enable MagicDNS and HTTPS certificates. Define the tags before any device exists:
   `tag:mend-operator` owns `tag:mend-ingress`, and nothing else uses either.
3. Create the operator's OAuth client with the write scopes `General/Services`, `Devices/Core` and
   `Keys/Auth Keys`, scoped to the operator tag. Precreate the `operator-oauth` Secret with
   `client_id` and `client_secret`; never pass them with Helm `--set`, in Git or on stdout.
4. Pin an exact operator chart version and its ARM64 image digests, with the operator and proxy on
   the same version. Before installing, change the chart's `proxies` Role to `rules: []`: upstream
   grants proxies namespace-wide access to Secrets, the OAuth credential included. Grant the proxy
   `get`, `patch` and `update` only on its own state Secret, plus events. Keep
   `apiServerProxyConfig.mode: "false"`.
5. Run the operator and proxy as UID/GID 1000 with `RuntimeDefault` seccomp, dropped capabilities
   and no privilege escalation, in a namespace that enforces restricted Pod Security, with no host
   networking or mounts. NetworkPolicy lets the proxy reach DNS, the Kubernetes API (its Service IP
   and endpoint IPs), Tailscale over public HTTPS and UDP, and `mend-web`, and nothing else: not the
   database, Sealant, the registry, Mend's API directly or the metadata address.
6. Give the tailnet a policy that admits only the owner to the ingress tag on 443, with tests for
   everything else. Grants are additive, so remove any starter allow-all rule:

   ```json
   {
     "groups": { "group:mend-users": ["owner@example.com"] },
     "tagOwners": {
       "tag:mend-operator": ["autogroup:admin"],
       "tag:mend-ingress": ["tag:mend-operator"]
     },
     "acls": [],
     "grants": [{ "src": ["group:mend-users"], "dst": ["tag:mend-ingress"], "ip": ["tcp:443"] }],
     "tests": [
       {
         "src": "owner@example.com",
         "accept": ["tag:mend-ingress:443"],
         "deny": [
           "tag:mend-ingress:22",
           "tag:mend-ingress:3101",
           "tag:mend-ingress:3106",
           "tag:mend-ingress:4000",
           "tag:mend-ingress:5432",
           "tag:mend-operator:443"
         ]
       }
     ]
   }
   ```

7. Set Mend's `APP_URL` to the `https://…ts.net` origin, then check from a tailnet device: health
   answers 200 with certificate verification on, an unauthenticated request gets 401, and only 443
   answers on the proxy.

To remove it: keep the operator running while you delete `mend/mend-access`, so its finalizer
removes the proxy and its tailnet device. Check that it did, then uninstall `tailscale-operator` and
remove its namespace, ProxyClass, the Mend ingress policy, the operator device, the OAuth client and
the unused tags and grants. Leave unrelated tailnet access alone. Removing access does not stop
executors or tear down AWS or PlanetScale.

## Footprint and boundaries

- VPC `10.42.0.0/16`, two AZs, private `/20` subnets, one NAT in `eu-central-1a`, and an S3 gateway
  endpoint. The worker stays in that AZ for gp3 reattachment and to avoid cross-AZ NAT charges.
- The EKS control-plane endpoint admits only the operator's CIDR; private access is on too. No SSH;
  IMDSv2, hop limit 1; an encrypted 40 GiB node boot disk. VPC CNI network-policy enforcement is on,
  in standard mode, which can briefly allow traffic before a policy attaches.
- PrivateLink has two endpoint ENIs. Its security group admits PostgreSQL only from the EKS workload
  group. The MicroVM connector has a different group and no database grant.
- An internal TCP NLB, `3106 → 31006`, admits only the MicroVM connector. The session channel is
  **plain HTTP inside the VPC**; session tokens protect its protocol.
- Separate IRSA roles for Mend, Sealant's API and worker, CNI and EBS CSI. The node has no capture
  or MicroVM privileges. Executors get per-session tokens and presigned S3 URLs, not database
  credentials or a bucket-wide role.
- The capture and build-artifact buckets block public access, require TLS, use SSE-S3 and abort
  incomplete multipart uploads after one day. **No versioning or object expiry**; both have
  `force_destroy=false`. Capture retention belongs to Mend. Capture objects can hold harness login
  material, which SSE-S3 does not hide from anyone allowed to read the bucket.
- An immutable-tag ECR repository; MicroVM build, connector and runtime-log roles; 14-day log
  groups. A MicroVM session runs for at most 8 hours, the platform's maximum
  (`SEALANT_MICROVM_MAX_DURATION_SECONDS`, 28800 by default); set `MEND_EXECUTOR_MAX_SECONDS` to
  match. Keep project standby counts at zero.
- A **$100 account-wide monthly budget**, with actual-spend alerts at $25 and $75 and a forecast
  alert at $100. It includes unrelated AWS use, excludes PlanetScale, and is **not a spending cap**.

Tags are `project=mend` and `environment=aws-capture-poc`; CSI volumes also carry the cluster tag.
The AWS provider cannot tag the MicroVM connector. This is not high availability: one worker, one
NAT, one CoreDNS and CSI controller, and node updates without surge. See
[issues-for-real-ha.md](issues-for-real-ha.md).

## Cost and teardown

[poc-cost-plans.md](poc-cost-plans.md) has the cost review. [TEARDOWN.md](TEARDOWN.md) is the
ordered teardown: deleting this checkout or closing a tunnel deletes no cloud resources.
