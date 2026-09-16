# Sealant control plane on the AWS POC

Standalone Kubernetes resources for Sealant Core `v0.32.0`. This directory deploys only the API,
worker, and the OCI build cache they require. It does not deploy Mend, expose HTTP/SSH, create AWS
resources or shared storage classes, create Secret values, build the MicroVM image, or apply
anything.

The contract comes from Core tag `v0.32.0` (`abe4d6c`), especially its environment reference,
Kubernetes BuildKit builder, MicroVM adapter, and published Helm chart. The control images are
pinned to `ghcr.io/sealant-sh/sealant-api:0.32.0` and `sealant-worker:0.32.0`. Zot and BuildKit
match that release's chart pins.

## Runtime shape

- `DEFAULT_RUNTIME_ADAPTER=microvm`, `DOCKER_RUNTIME_ENABLED=false`, and
  `AWS_EC2_METADATA_DISABLED=true` on both application processes.
- The worker gets the image ARN, exact image version, VM execution role, VPC egress connector,
  managed ingress connector, runtime log group, and a 3,600-second maximum duration as explicit
  environment values.
- The API gets the MicroVM region and shared control bearer token so it can mint endpoint tokens.
- `SEALANT_K8S_BUILD_NAMESPACE=sealant-build` selects Core's supported BuildKit Job builder.
  `SEALANT_K8S_NAMESPACE` is deliberately absent. This keeps the Kubernetes runtime adapter and
  Kubernetes launch-material stager disabled; the MicroVM adapter sends its inline launch archive.
- Rootless BuildKit runs in a separate Pod Security `privileged` namespace with no service-account
  token. The worker has only the BuildKit builder's actual namespaced verbs.
- Build requests are `500m` CPU and `1Gi` memory. API, worker, and Zot requests total another `250m`
  CPU and `1Gi` memory. Limits allow bursts but do not reserve that capacity.
- Zot is an unauthenticated, cluster-only, plain-HTTP registry on a 10 GiB encrypted gp3 claim. Core
  v0.32.0's BuildKit integration supports this directly. ECR would need registry credentials or a
  credential-helper path that this builder does not expose, so this deployment does not pretend IRSA
  alone authenticates BuildKit to ECR.

Core v0.32.0 always builds and publishes an OCI workspace image before runtime launch. The MicroVM
adapter then launches the separately built, versioned Lambda MicroVM image and sends the workspace
archive inline. The OCI artifact is real build output, but it is not the VM root image. The live
smoke test reports both phases separately.

## Inputs

The parent infrastructure supplies `tofu output -json`, the API and worker IRSA role ARNs, and the
MicroVM image ARN/version. `render.py` reads these output names:

- `region`
- `microvm_exec_role_arn`
- `vpc_egress_connector_arn`
- `microvm_exec_log_group`
- `application_role_arns`, whose `value` has `sealant_api` and `sealant_worker` entries

The renderer also accepts the older flat `sealant_api_irsa_role_arn` / `sealant_api_role_arn` and
`sealant_worker_irsa_role_arn` / `sealant_worker_role_arn` shapes. Either role may instead be passed
with `--api-role-arn` and `--worker-role-arn`.

The parent creates `sealant-secrets` in the Sealant namespace with these keys:

- `DATABASE_URL`
- `SEALANT_CREDENTIALS_KEY` (base64 encoding of exactly 32 random bytes)
- `SEALANT_SERVICE_KEYS`
- `SEALANT_CONTROL_BEARER_TOKEN`

The API and worker reference the same bearer-token key. No secret value is rendered or tracked. Each
Secret name and key can be overridden independently; see `render.py --help`.

The IRSA policies stay in the parent OpenTofu stack. Core v0.32.0's API code uses
`lambda:CreateMicrovmAuthToken`. The worker uses `lambda:RunMicrovm`, `lambda:GetMicrovm`,
`lambda:TerminateMicrovm`, and `lambda:CreateMicrovmAuthToken`. The worker also needs `iam:PassRole`
restricted to the rendered `microvm_exec_role_arn`. The live RunMicrovm request failed with the
`iam:PassedToService=lambda.amazonaws.com` condition, so that condition is absent. The exact
execution role is log-only and trusts Lambda only. Keep the trust subjects exact:

```text
system:serviceaccount:sealant:sealant-api
system:serviceaccount:sealant:sealant-worker
```

Neither Sealant service needs S3 access. Mend owns the capture store and presigns executor URLs; do
not grant the hostile VM execution role S3 access.

## Render and inspect

```sh
cd deploy/aws/tofu
tofu output -json >../kubernetes/tofu-output.json
cd ../kubernetes

./render.py \
  --outputs tofu-output.json \
  --microvm-image-arn 'arn:aws:lambda:eu-central-1:954648881795:microvm-image:NAME' \
  --microvm-image-version 'VERSION' \
  --output output/sealant.yaml
./validate.sh output/sealant.yaml
```

The local `output/` directory and `tofu-output.json` are ignored. Inspect the rendered
ServiceAccounts, Secret references, and all MicroVM values before the parent applies it. There is
intentionally no apply script.

`configure-kubeconfig.sh tofu-output.json [path]` verifies the caller's AWS account and writes only
a local kubeconfig. It calls read-only AWS APIs and does not change the cluster.

## After the parent applies

The read-only smoke path checks deployments, RBAC, API `/healthz`, Zot `/v2/`, and confirms that
`SEALANT_K8S_NAMESPACE` stayed unset:

```sh
./smoke.sh --secret sealant-secrets
```

A real workspace is the only honest proof of the BuildKit and MicroVM path. Supply a request body
produced for the public Core v0.32.0 `POST /v1/workspaces` contract, then opt in to the
state-changing test:

```sh
./smoke.sh --secret sealant-secrets \
  --workspace-request /secure/path/workspace-request.json \
  --launch
```

The script reads the service key into memory, queues one workspace, waits until the response
contains both a published image and runtime adapter `microvm`, and does not print the key. This
creates build objects, a registry artifact, database rows, and a billable MicroVM. Stop/delete the
workspace through the owning Mend/Core workflow afterwards.

## Readiness blockers and checks

Before apply:

1. The parent must create the shared `mend-gp3` StorageClass before this manifest. It uses the EBS
   CSI driver, encrypted gp3, `WaitForFirstConsumer`, and `Delete` reclaim in this disposable POC;
   the CSI add-on supplies the project, environment, and cluster volume tags. The parent Secret and
   both IRSA roles must also exist with the exact namespace/service-account trust. Both service
   accounts request regional STS endpoints.
2. The public `sealantd:0.15.2` ARM64 image lacks `sealantctl`, which the MicroVM recipe and its
   suspend/terminate hooks require. The deployed private candidate adds the CLI built from the exact
   daemon release source; the AWS image reached `CREATED`, version `1.0`, on agent port `8080`. The
   real replacement test restored a file, ran `capture flush`, and exited 0. This is candidate-image
   evidence, not proof that the unmodified public daemon image works. See the
   [deployment record](../README.md). Never bypass the flush hook.
3. The EKS node must allow unprivileged user namespaces. Rootless BuildKit otherwise fails before
   the MicroVM launch phase. The build namespace permits the unconfined profile Core emits.
4. PlanetScale private DNS/TLS and `DATABASE_URL` must work from the API/worker security group.
5. The VPC CNI must have network-policy enforcement enabled before the included policies provide
   isolation. ClusterIP-only Services and security groups remain the boundary otherwise.
6. Run the opt-in smoke on the actual ARM64 node. Build architecture/package compatibility is an
   observed result, not a claim from manifest validation.

No SSH gateway, browser UI, Ingress, public LoadBalancer, workspace Kubernetes runtime, Docker
socket, or static registry credential is present.
