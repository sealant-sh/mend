# AWS workspace Docker service

## Status

The bounded provider test passed on 2026-09-16 using candidate image 3.0. It exercised the real AWS
MicroVM adapter and authenticated control channel, not the deployed Mend provisioning flow.

The deployed Sealant 0.32.0 server still refuses Docker in MicroVM workspaces. The changes under
review add an opt-in platform image and guest service. They do not change the deployed API, worker,
default image or user sessions.

Local tests cover packaging, capability selection, guest readiness and failure handling. Candidate
image version 1.0 reached `CREATED`; the provider confirms `additionalOsCapabilities: ["ALL"]`. The
first real provider test on 2026-09-16 launched a VM but failed Docker startup. It did not reach
build, run or Compose acceptance. The test terminated the VM, and an independent AWS query confirmed
`TERMINATED` with a configured 900-second maximum. The retained failure classification identifies
Docker startup, not its underlying cause.

Image 2.0 added a real Docker startup check to AWS's post-snapshot validation hook and failed it.
The bounded diagnostics showed a missing Unix-socket parent directory, despite UID 0 and the
required capabilities. Build-time directory creation was insufficient. The service now prepares its
private runtime directories before spawning dockerd. Image 3.0 passed AWS validation, including
`docker info` and daemon cleanup.

The second real VM, using image 3.0, passed Docker 29.8.1 info, build, run, Compose and root-owned
workspace bind writes. Its HTTP fixture exited before forwarding could be tested. Local reproduction
found a fixture defect: Alpine 3.20's BusyBox does not include `httpd`. The VM was terminated and
independently verified.

The third VM passed the complete test on image 3.0 after replacing the HTTP fixture with a locally
verified, digest-pinned BusyBox image. Observed passes were Docker 29.8.1 info, build, run, Compose,
root-owned bind writes, an HTTP response through authenticated forwarding, default nested-container
DNS, no listeners on Docker TCP ports 2375/2376, and detection of deliberate dockerd termination. No
DNS override was needed. The test exited 0.

All three acceptance VMs were independently confirmed `TERMINATED`, with a 900-second configured
maximum each. The disposable candidate image and all three exact S3 build artifacts were deleted.
The ordinary image remains version 1.0 without additional capabilities. Shared infrastructure,
deployed services and user sessions were not changed. Private evidence remains outside Git.

The authorized ceilings were ten candidate image builds and five disposable acceptance VMs; three
builds and three VMs were used. This work did not authorize a production rollout or paid inference.

Mend already sends `services: { docker: true }` through the public SDK. There is no Mend startup
script that installs or starts Docker. See [platform feedback](../../PLATFORM-FEEDBACK.md) and the
[existing AWS deployment](../../deploy/aws/README.md).

## What the platform changes

Docker requests select a separate image, identified by a pinned ARN and version. Ordinary workspaces
keep the default image. The Docker variant adds Engine, Buildx, Compose and networking tools, then
starts dockerd when a workspace launches. It does not snapshot a running daemon into the image. The
post-snapshot image validation hook starts Docker, checks `docker info`, and stops it before
reporting success. Runtime directories are prepared on each start rather than relying on directories
created by the Dockerfile. Image validation does not run a nested container.

The Docker guest uses a version-2 required-service handshake. An old or incapable image cannot
silently accept the request. The guest waits for `docker info` before starting sealantd; Core also
checks the authenticated agent and real control channel. A daemon exit fails immediately. After
readiness, isolated probe failures have a bounded grace period rather than killing a busy workspace.

A confirmed Docker failure denies new control connections and makes Core inspect report the executor
exited. Sealantd stays alive for the terminate hook's capture flush. The worker's exit reconciler
then terminates the VM. If the worker is unavailable, the VM's maximum duration remains the final
lifetime limit.

### Privilege and storage

AWS applies `additionalOsCapabilities: ["ALL"]` to the application container inside this separate
MicroVM image. This is guest-root Docker, not the rootless Docker sidecar used on Kubernetes. The
capabilities apply to the workspace container, not just dockerd. Do not describe this as rootless
parity or enable it on the ordinary image.

- The client uses `unix:///run/docker/docker.sock`. No Docker TCP listener or host/node socket is
  configured.
- Docker routing and TLS environment keys belong to the service. Secret environment injection cannot
  override them. `DOCKER_CONFIG` remains available for registry authentication.
- Docker stores its graph under `/var/lib/sealant/docker`, outside the captured worktree. Images,
  containers and named volumes disappear with the executor. Capture durable files through the
  workspace, not a Docker volume.
- Docker diagnostics stay in a bounded, root-only guest file. They are not returned by health
  responses or copied into the session record.

This does not make AWS run the OCI image produced by a workspace-profile BuildKit build. Custom base
images, arbitrary profile package parity, native agent resume and full Talos parity remain separate
work.

## Build a candidate

Use the AWS tools and account checks described in the deployment README. Keep credentials, artifact
metadata and build logs outside Git. The default wrapper still uses its existing immutable Core
revision and ordinary recipe.

A Docker build requires an explicitly reviewed newer recipe. Choose one source:

- `SEALANT_MICROVM_SOURCE_DIR`, a local directory containing the reviewed platform image files; or
- `SEALANT_MICROVM_SOURCE_REV`, the complete 40-character commit SHA of a platform revision that
  contains the Docker recipe.

Do not set both. The wrapper stages only the required recipe files, rejects missing files and
symlinks, and adds the pinned Mend coding tools to the selected recipe.

Alongside the existing build role, bucket, logging and daemon-image settings, configure:

```bash
export MICROVM_IMAGE_NAME=mend-capture-poc-workspace
export MICROVM_DOCKER_IMAGE_NAME=mend-capture-poc-workspace-docker-candidate
export MICROVM_DOCKER_ENABLED=true
```

Choose a separate candidate name before use. It must differ from the ordinary image name. `--update`
updates the selected Docker candidate, not the default image. Record the source file hashes,
artifact location, resulting image ARN/version and the provider's capability metadata. Do not infer
the image version from its name.

The public `sealantd:0.15.2` packaging gap still applies: the recipe requires the matching
`sealantctl` binary for capture flushes. Use the reviewed private daemon candidate described in the
AWS README until the platform publishes a complete image. Do not remove the flush hook.

## Release and activation

Activation is a separate operation after provider acceptance and a platform release. Both API and
worker must run the new implementation and receive the same pair:

```text
SEALANT_MICROVM_DOCKER_IMAGE_ARN=<separate Docker image ARN>
SEALANT_MICROVM_DOCKER_IMAGE_VERSION=<exact tested version>
```

Keep the existing default `SEALANT_MICROVM_IMAGE_ARN` and version. A partial Docker pair, a dangling
pair without the base MicroVM adapter, or reuse of the ordinary image ARN must be rejected. The
current AWS renderer pins the deployed server version; this source change is not an instruction to
apply a new manifest or patch the running deployments.

Do not enable `DOCKER_RUNTIME_ENABLED` or set `SEALANT_K8S_NAMESPACE`. Neither activates Docker
inside a MicroVM. Mend's Docker profile setting applies when it creates a fresh workspace; joining
or resuming a retained executor does not install a new service into it.

## Acceptance and cleanup

The opt-in platform test runs through the real MicroVM adapter, provider API and authenticated
sealantd control helpers. It is not a full Mend session or public-SDK provisioning acceptance test.
It must prove Docker info, build, run, Compose, a root-owned workspace bind write, an inner HTTP
service through authenticated forwarding, default nested-container DNS, closed Docker TCP ports, and
explicit daemon-failure reporting. No model call is needed. This test does not establish native VM
suspend/resume behavior, sustained resource limits, or combined Docker-plus-capture restoration.

Verify the actual AWS caller account and region before enabling the test. Its expected-image checks
compare configuration; they do not authenticate the operator. Use a fresh test control secret, not
the deployed server's secret. Keep safe resource IDs and bounded test evidence in a private
directory so a failed test can still be cleaned up.

The test must terminate its exact VM and verify `TERMINATED`, including failures during readiness.
After acceptance, delete only the owned disposable candidate image and staged S3 build artifact.
Record cleanup before declaring the test complete. Do not delete a shared bucket, role, connector,
log group, ordinary image or unrelated executor. Production image retention and rollout require
separate approval.
