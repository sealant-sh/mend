# AWS POC costs and deployment plan

Updated 2026-09-16. This records the cost review and the path from the running POC to a customer
installer. It does not authorize infrastructure changes, further acceptance VMs or team access.

See the [deployment overview](README.md),
[Docker service record](../../docs/operations/aws-docker-service.md),
[private access record](../../docs/operations/aws-access-deployment.md) and
[teardown procedure](TEARDOWN.md). The [workbench plan](../../MEND-AGENT-WORKBENCH-PLAN.md) remains
the product source of truth.

## Summary

- The current dedicated installation costs about **$290/month before workspace usage**.
- A running workspace costs about **$0.319/hour at its baseline allocation**.
- Docker has no separate licence or fixed infrastructure charge. It can increase resource usage,
  session duration and network traffic.
- The existing $100 AWS budget is an alert, not a cap. AWS fixed costs alone are about $230/month.
- A repeatable private installation and safe multi-user operation are separate deliverables.

## Cost basis

These are Frankfurt `eu-central-1` list-price estimates, using 730 hours/month, in USD before tax,
credits or negotiated discounts. They are a monthly run rate, not an invoice or bill-to-date.
Image-building work is excluded.

The review checked AWS regional price catalogs and the deployed node, attached disks and PlanetScale
SKU. The node has 70 GB of attached gp3 storage in total: 40 GB boot, 20 GB Mend and 10 GB registry.
The application claims are those same attached disks, not additional storage. PlanetScale reports
the ARM M-10 Metal configuration with 10 GiB local disk and two replicas.

### Always-on resources

| Resource                                | Calculation                             | Monthly estimate |
| --------------------------------------- | --------------------------------------- | ---------------: |
| EKS control plane, standard support     | 730 hours × $0.10                       |           $73.00 |
| One ARM64 `m7g.large` application node  | 730 hours × $0.0978                     |           $71.39 |
| One NAT gateway                         | 730 hours × $0.052                      |           $37.96 |
| NAT public IPv4 address                 | 730 hours × $0.005                      |            $3.65 |
| Internal network load balancer          | 730 hours × $0.027                      |           $19.71 |
| PrivateLink endpoint in two AZs         | 730 hours × 2 × $0.012                  |           $17.52 |
| 70 GB gp3 storage                       | 70 × $0.0952 per GB-month               |            $6.66 |
| **AWS fixed subtotal**                  |                                         |      **$229.90** |
| PlanetScale M-10 ARM, 10 GiB, Frankfurt | Whole cluster, primary and two replicas |           $60.00 |
| **Combined fixed total**                |                                         |      **$289.90** |

EKS extended-support fees are not included. Keep Kubernetes on a supported version. This
installation is not highly available: it has one application node, one NAT gateway and AZ-bound
application storage. PlanetScale's replicas do not make the whole installation HA.

### Workspace compute

Both retained workspace images, ordinary and Docker-capable, are ARM64 with a 4096 MiB minimum
memory allocation. The baseline is 4 GB memory and 2 vCPU.

Frankfurt ARM MicroVM rates checked during this review:

- CPU: $0.000034996 per vCPU-second.
- Memory: $0.000004633 per GB-second.

Baseline hourly cost:

```text
3600 × [(2 × 0.000034996) + (4 × 0.000004633)] = $0.3186864
```

| Total running workspace-hours | Baseline compute estimate |
| ----------------------------- | ------------------------: |
| 1                             |                     $0.32 |
| 100                           |                    $31.87 |
| 400                           |                   $127.47 |
| 1,000                         |                   $318.69 |

These are running VM hours, including time waiting for a person. They are not just active agent or
CPU-work time. Do not assume automatic idle suspension savings; that behavior has not been accepted
as a supported Mend lifecycle here.

MicroVMs can scale to four times baseline. Extra resources are billed for their actual usage above
baseline. Sustained full allocation at 8 vCPU and 16 GB would cost about $1.275/hour. For an
illustrative workload spending 25% of its time at that full allocation and the rest at baseline, 400
workspace-hours would cost about $223.08 instead of $127.47.

The current provider maximum duration is 3600 seconds. That bounds one executor's lifetime; it does
not limit the number of sessions or establish an account-wide spending cap.

### Does Docker add running costs?

Docker Engine runs inside the existing workspace MicroVM. Enabling it does not create another EC2
instance, Kubernetes node or always-on Docker host. The ordinary and Docker images have the same
baseline allocation. Docker Engine has no per-seat licence charge in this setup; Docker Desktop is
not involved.

Docker can still increase the bill by:

- Using burst CPU or memory beyond the baseline.
- Keeping the workspace running longer for builds, containers or tests.
- Pulling images and transferring build artifacts. NAT data processing costs $0.052/GB in this
  region, separate from applicable transfer charges.
- Repeating downloads because the Docker graph and cache are disposable.

There is no flat Docker surcharge. Equal baseline allocation and runtime have equal baseline compute
costs, whether Docker is enabled or not.

### Other charges and an example

The fixed-cost table excludes:

- S3 capture and artifact storage, requests and applicable transfer charges.
- ECR and MicroVM snapshot storage, snapshot reads and writes.
- CloudWatch log ingestion and retention.
- NAT data processing, cross-AZ traffic, network transfer and load-balancer capacity usage.
- AWS PrivateLink data processing and PlanetScale traffic or backup overages.
- AI-provider usage or subscriptions, including interface-side inference.
- Tailscale subscriptions and any applicable resource add-ons.

Five developers each using one workspace for four hours on 20 days produce 400 workspace-hours. At
baseline, that is about $417/month including the fixed installation. Tailscale Standard at $8 per
seat adds $40/month for five people, bringing the example to about $457 before the other variable
charges. Its Personal plan is for non-commercial use.

This is a cost example, not a claim that team authorization or that workload's capacity has passed
acceptance. Concurrent sessions count separately. AI-provider costs remain separate.

Customers with suitable existing EKS, networking or database resources may have lower incremental
costs. Reuse needs explicit installer support and isolation checks; it is not assumed above.

### Pricing sources

Prices were checked on 2026-09-16. Recheck before quoting a deployment.

- [AWS Lambda pricing and billing model](https://aws.amazon.com/lambda/pricing/).
- [Frankfurt Lambda price catalog, including ARM MicroVM rates](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/eu-central-1/index.json).
- [Frankfurt EC2 price catalog, including node, NAT and gp3 rates](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-central-1/index.json).
- [Frankfurt EKS price catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEKS/current/eu-central-1/index.json).
- [Frankfurt load-balancer price catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-central-1/index.json).
- [Frankfurt VPC price catalog, including endpoint and IPv4 rates](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-central-1/index.json).
- [PlanetScale Frankfurt cluster prices](https://planetscale.com/pricing.md?region=eu-central).
- [PlanetScale storage, traffic and backup billing](https://planetscale.com/docs/postgres/pricing).
- [Tailscale pricing](https://tailscale.com/pricing).

## Path to a customer installer

Build a versioned, resumable installer around the existing OpenTofu and Helm/Kubernetes assets. Do
not turn the operator's command history into a large shell script.

Ship an explicitly private, single-owner beta first. Installing in a team's AWS account does not
establish safe multi-user operation. The present deployment also requires PlanetScale and Tailscale
accounts; it is not an AWS-only offering.

### 1. Define one deployment contract

Use one validated configuration for AWS account, region, deployment name, CIDRs, operator access,
database, hostname, secret references, resource limits and Docker support. Remove POC-specific
account IDs, resource names, endpoint services and private configuration paths from reusable code.

A release manifest must pin application digests, workspace recipes, the daemon and CLI, and the
installer toolchain. Pin nixpkgs rather than relying on the operator's ambient version.

Preflight must check caller identity, permissions, quotas, actual MicroVM API/account/region
availability, connector support, ARM64 compatibility, EKS/AMI/add-on versions and database AZ
support. Changing a region string is not enough to establish regional support.

### 2. Make provisioning repeatable and recoverable

The proposed command interface is:

```text
mend deploy aws plan
mend deploy aws apply
mend deploy aws status
mend deploy aws doctor
mend deploy aws verify
mend deploy aws upgrade
mend deploy aws destroy --retain-data
```

These commands are a proposal, not existing functionality.

- Bootstrap a separate encrypted, versioned, locked remote state store with scoped operator access.
  Current ToFu state is local and unencrypted.
- Show estimated costs and require approval before provisioning or paid acceptance tests.
- Record resource ownership, including objects outside ToFu: MicroVM images and artifacts,
  Kubernetes objects, PlanetScale resources and Tailscale configuration.
- Checkpoint deployment phases, reconcile interrupted operations and preserve existing secrets,
  identities and data on reruns. Reject conflicting installations.
- Review drift before upgrades. Check migration compatibility, take backups and state what a
  rollback can recover. Image rollback alone does not undo a database migration.
- Keep the existing teardown dependency order. Flush and stop sessions, independently verify VM
  termination, and remove ingress finalizers and volumes while their controllers still exist. Retain
  data by default; require separate approval to delete it.

### 3. Package the database and workspace runtime

Automate PlanetScale's supported provisioning workflow or require validated existing resources.
Cover PrivateLink acceptance and DNS, public-access restrictions, verified TLS, separate Mend and
Sealant databases and roles, and sufficient connection capacity. Direct connections must support
`LISTEN/NOTIFY`; the POC required `max_connections=50`.

Replace private role-JSON handoffs with a documented secret-store workflow. Preserve authentication,
encryption and control identities across reruns. Define rotation and recovery, and gate both
applications' migrations. An AWS-only option such as RDS requires separate compatibility and
recovery acceptance.

Publish a matching, digest-pinned daemon image containing `sealantctl`. The public `sealantd:0.15.2`
image lacks it. Do not make customers depend on the private candidate or remove capture hooks.

Generate ordinary and optional Docker image ARN/version pairs for both API and worker from the same
configuration. Generate both IAM policies' exact image grants from it too. Docker uses additional
guest-root capabilities, not a node Docker socket. Do not promise rootless Docker or arbitrary OCI
workspace-profile parity; the fixed AWS image does not establish either contract.

### 4. Reproduce private access from source

The current renderers do not reproduce the complete live installation. Mend's renderer defaults to
0.27.5 and localhost; the standalone Sealant renderer omits the live Docker pair and digest pins.
Replace these mismatches with release-manifest-driven rendering.

Ship reusable, non-secret access configuration with matching API/web origins and owner-only HTTPS.
Keep Funnel disabled. Encode the reviewed Tailscale RBAC restriction: the proxy may access its exact
state Secret, not the operator's OAuth credentials. Handle state-name changes and upgrades without
broadening Secret access. Test CNI startup isolation as well as steady-state policies.

### 5. Prove operation before promising reliability

Define downtime expectations, backup scope, recovery point and recovery time objectives. Restore
coordinated database, capture, application-store and key backups. Adding replicas alone does not
solve AZ-bound storage or singleton supervision.

Add concurrency, executor-duration, storage and capture-byte controls, orphan reconciliation,
monitoring and cost estimates. Budget alerts alone cannot enforce these limits.

Private beta acceptance should cover fresh installation, rerun, interruption recovery, upgrades,
rollback, restore, phone and CLI access, sustained WSS/SSE connections, certificate renewal, access
revocation and teardown. Exercise real shell-only Docker and capture retrieval/restoration with
explicit resource limits and verified cleanup.

The completed Docker session passed its runtime checks and capture-flush observations. Its
supplementary flush ran after termination and prevented the checker from reaching the post-stop file
read. Docker-plus-capture restoration remains unverified. Earlier ordinary-workspace replacement
proved worktree restoration, not native harness conversation resume. Do not relaunch closed
acceptance runs without new authorization.

### 6. Gate team access separately

Before a multi-user release, verify closed enrollment, operator roles, project authorization,
per-user credentials and audited service delegation. Test live stream and presigned-access
revocation, and run two-account capture-mode isolation tests. Private networking is not a substitute
for application authorization.

The first milestone is a reproducible owner-only installation with cost estimates, bounded tests and
tested recovery. Safe team access is a separate release gate. Public access and HA need their own
acceptance; neither follows from a successful installer run.
