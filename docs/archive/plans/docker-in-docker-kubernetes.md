# Docker inside workspaces on Kubernetes — implementation plan

> Historical record (2026-09-26): never started. Superseded by Docker in MicroVM workspaces (#262,
> Sealant 0.36.1 in #318).

> Status: proposed 2026-09-03, not started. Evidence comes from the talos-ceph cluster (Talos
> v1.13.9, Kubernetes v1.36.3, containerd 2.2.7, runc 1.3.3, kernel 6.18) and a fresh clone of
> `sealant-sh/sealant` at `c1b3c65` (2026-09-02). The local `sealant-core` checkout is stale
> (2026-07-08, SDK 0.5.0) and has no Kubernetes adapter; do not plan against it.

## The one-paragraph version

Run the same rootless `docker:*-dind-rootless` daemon the Docker adapter already uses, as a native
sidecar in the workspace Pod, with `privileged: true` inside a **user-namespaced Pod**
(`hostUsers: false`). Root in the Pod maps to an unprivileged host UID, so "privileged" means
privileged over the Pod's own namespace and nothing else. The daemon listens on a unix socket in a
shared `emptyDir`; the workspace gets `DOCKER_HOST=unix:///run/docker/docker.sock`. A `hostAliases`
entry maps `docker` to `127.0.0.1` so Mend's existing Service dial chain (loopback, then `docker`)
works unchanged. I ran this exact shape on the cluster today and it builds images, runs containers,
publishes ports back into the Pod, and cannot open the node's disks. The plain privileged sidecar
(no user namespace) also works but hands every coding agent node root. The unprivileged rootless
variant does not work on Talos without a `/dev/net/tun` device plugin.

## Why now

- Mend defaults `services.docker` to `true` (`packages/domain/src/settings.ts:82-89`) and passes it
  through unconditionally (`packages/sessions/src/engine.ts:2645`). The Kubernetes adapter refuses
  it at launch (`packages/workspaces/src/runtime/kubernetes/adapter.ts:190-197`), so the cluster's
  Mend settings currently have Docker switched off. Every project that needs `docker compose` or
  testcontainers is blocked on that cluster.
- The refusal happens in the worker at launch, not at `POST /v1/workspaces`. Mend learns about it
  minutes later as an `unsupported-runtime` error. `PLATFORM-FEEDBACK.md:85-101` already asks for a
  create-time capability signal for exactly this.
- The docs promise it: `apps/docs/.../deploy-kubernetes.md:175` says Docker is "refused on
  Kubernetes until the DinD capability ships", and Sealant's own design doc reserves the slot
  (`docs/kubernetes-support-design.md:181-182`: "DinD is a later PR and the only privileged
  container").

## What exists today

### The Docker adapter's sidecar (the contract to match)

`packages/workspaces/src/runtime/docker-runtime-adapter.ts:669-735` creates a per-workspace bridge
network, then runs `docker:27.5.1-dind-rootless` with `--privileged`, `DOCKER_TLS_CERTDIR=` and
`--tls=false`, network alias `docker`, and polls `docker -H tcp://127.0.0.1:2375 info` until ready.
The workspace container joins that network with `DOCKER_HOST=tcp://docker:2375` (`:1000-1015`). No
volume for `/var/lib/docker`; the graph dies with the container. Teardown is unconditional
`docker rm -f` plus `network rm` (`:738-745`). The golden argv test pins all of it and must stay
byte-identical (`docs/kubernetes-support-design.md:240-243`).

So the platform's public promise is "rootless image, privileged container, never the host socket".
The Kubernetes design below keeps that promise and adds a boundary the Docker path does not have.

### The Kubernetes workspace Pod

`packages/workspaces/src/runtime/kubernetes/manifests.ts:382-487` builds a single-container Pod:
root user, `privileged: false`, drop ALL then add `CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL`,
`seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`, `emptyDir` at
`/run/sealant`, TLS and launch Secrets, store PVC subPaths, optional `runtimeClassName` for gVisor.
No `hostUsers`, no sidecars, no init containers. Verified live on the cluster: the workspace
container cannot even `unshare -U` (seccomp plus dropped caps), has no `/dev/fuse`, and no docker
CLI because Docker is off in Mend settings.

The image side is already done. `buildkit-builder.ts:1193-1199` copies the docker CLI and the
compose plugin into any image whose blueprint has `services.docker.enabled`, on every runtime.

### The cluster

| Fact                       | Value                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| Nodes                      | 3 workers, 4 vCPU / 12 GiB each, Proxmox VMs with `vmx` exposed       |
| Node ephemeral disk        | 120 GiB, talos2-w3 at 79 % used                                       |
| Ceph                       | 450 GiB raw, 30 % used; `mend-store` is CephFS RWX 200 GiB            |
| Workspace namespace PSA    | `enforce: privileged` (already, because rootless BuildKit needs it)   |
| `user.max_user_namespaces` | 65536 (patch-userns.yaml)                                             |
| Registry                   | zot at `10.0.0.211:5000`, plain HTTP, outside the cluster             |
| Workspace egress           | DNS, mend:3106, `0.0.0.0/0` except RFC1918 and the metadata IP        |
| Kubelet user namespaces    | GA and on by default in 1.36; containerd 2.2 supports idmapped mounts |

## What I tested on the cluster (2026-09-03)

Five throwaway Pods in `sealant-workspaces`, all deleted afterwards. Same checks in each:
`docker info`, `docker run alpine`, `docker build`, `-p 8080:80` reachable from the Pod, a nested
`--privileged` container, a memory limit, and whether the container can read `/dev/sda`.

| Variant                                                                                  | Result                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker:28-dind`, `privileged: true`, host users                                         | Everything works. overlay2 on xfs, cgroup limits honoured. **Reads `/dev/sda`; full host capabilities.** This is node root.                                                                                                                                                                                                   |
| `docker:28-dind`, `privileged: true`, `hostUsers: false`                                 | dockerd cannot start. The container's cgroup is owned by real root (65534 inside), so it cannot write `cgroup.subtree_control`. runc 1.3.3 does not delegate the cgroup to the Pod's user namespace.                                                                                                                          |
| `docker:28-dind-rootless`, `privileged: true`, `hostUsers: false`                        | **Works.** overlay2, build, run, port publish reachable on both `127.0.0.1` and the Pod IP, nested privileged works inside the namespace. Cgroup driver is `none`, so per-container limits are ignored; the Pod limit still applies. `/dev/sda` exists but open fails with permission denied. Pod root is host UID 941948928. |
| `docker:28-dind-rootless`, not privileged, caps + Unconfined seccomp, `hostUsers: false` | Fails. rootlesskit cannot create its tap device (no `/dev/net/tun`). Needs a device plugin; deferred.                                                                                                                                                                                                                         |
| CephFS `subPath` mount inside a `hostUsers: false` Pod                                   | Works. Files written by Pod root land on the store as uid 0, exactly as today, and `mend-api` (uid 1000) sees them.                                                                                                                                                                                                           |

Two details from the working variant matter for the design. The rootless image ships
`rootless:100000:65536` in `/etc/subuid`, which is outside the 65536 IDs a user-namespaced Pod gets,
so the sidecar has to rewrite it to `rootless:1001:64534` before starting. And passing an explicit
`--host=tcp://127.0.0.1:2375` binds inside rootlesskit's private netns where nothing can reach it;
the unix socket is the right transport in a Pod anyway.

## Design

### Pod shape when `services.docker.enabled` is true

```yaml
spec:
  hostUsers: false # new: pod-level user namespace
  hostAliases:
    - ip: 127.0.0.1
      hostnames: [docker] # keeps forward({ host: "docker" }) working
  initContainers:
    - name: docker
      image: docker:28.3.3-dind-rootless # pinned via SEALANT_K8S_DOCKER_IMAGE
      restartPolicy: Always # native sidecar: starts first, dies with the Pod
      command: ["/bin/sh", "-c"]
      args:
        - |
          echo rootless:1001:64534 > /etc/subuid
          echo rootless:1001:64534 > /etc/subgid
          mkdir -p /run/docker && chown 1000:1000 /run/docker
          exec su rootless -s /bin/sh -c 'export XDG_RUNTIME_DIR=/run/docker HOME=/home/rootless \
            PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DOCKER_TLS_CERTDIR=; \
            exec dockerd-entrypoint.sh dockerd --host=unix:///run/docker/docker.sock \
              --data-root=/var/lib/docker'
      securityContext: { privileged: true, runAsUser: 0 }
      startupProbe:
        exec: { command: [docker, -H, unix:///run/docker/docker.sock, info] }
        periodSeconds: 1
        failureThreshold: 90
      resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { cpu: "2", memory: 2Gi } }
      volumeMounts:
        - { name: docker-run, mountPath: /run/docker }
        - { name: docker-graph, mountPath: /var/lib/docker }
  containers:
    - name: workspace
      env:
        - { name: DOCKER_HOST, value: unix:///run/docker/docker.sock }
        - { name: DOCKER_TLS_CERTDIR, value: "" }
      volumeMounts:
        - { name: docker-run, mountPath: /run/docker }
      # securityContext unchanged: not privileged, caps dropped, RuntimeDefault seccomp
  volumes:
    - { name: docker-run, emptyDir: {} }
    - { name: docker-graph, emptyDir: { sizeLimit: 20Gi } } # SEALANT_K8S_DOCKER_GRAPH_SIZE
```

Everything else in the Pod (store subPaths, TLS, launch Secret, priority class, topology spread,
labels) stays as `buildPod` emits it today.

### Why these choices

**User namespace, not just privileged.** The privileged flag is what makes rootlesskit's network and
mount setup work without a device plugin. The user namespace is what stops that flag from meaning
node root. Both together give the same daemon the Docker adapter runs, behind a boundary the Docker
adapter does not have. The workspace container also ends up user-namespaced, which is a free
hardening for the coding agent itself, and CephFS behaves identically (verified).

**Native sidecar, not a second container.** An init container with `restartPolicy: Always` starts
before the workspace container and the kubelet waits for its `startupProbe`, so the agent never sees
a socket that is not there yet. It is killed with the Pod, so the adapter's stop path
(`adapter.ts:497-523`) needs no new object to delete. Needs Kubernetes 1.29+; the cluster is 1.36.

**Unix socket, not TCP.** There is no network hop inside a Pod. The socket sits in an `emptyDir`
shared between the two containers. Pod root can open the uid-1000-owned socket through
`DAC_OVERRIDE`, which the workspace container already has.

**`hostAliases` for the `docker` name.** Mend dials loopback first and `docker` second
(`packages/sessions/src/service-host.ts:304-315`, `apps/api/src/routes/service-tunnel.ts:91-98`),
and the API only admits `127.0.0.1 | localhost | docker` as forward hosts. rootlesskit publishes
nested ports into the Pod netns (verified reachable at `127.0.0.1:8080`), so mapping `docker` to
loopback makes the existing chain correct without touching the SDK allowlist.

**`emptyDir` with a size limit for the graph.** Same reasoning as the BuildKit Job
(`images/kubernetes/builder.ts`): overlay2 wants a local xfs/ext4 upper dir, and CephFS is a poor
one. The kubelet evicts the Pod when the limit is exceeded, which surfaces as the workspace ending
rather than a silent hang. This is the "disk ceiling" capability Mend wants to report.

**Operator-gated.** A workspace blueprint asks for Docker; only the operator can allow it, the same
framing as `allowedServiceAccounts`. New value `workspaces.docker.enabled` (default `false`) wired
to `SEALANT_K8S_DOCKER_ENABLED`. When false, the adapter keeps refusing, with a message that names
the value.

### Alternatives considered

| Option                                               | Verdict                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privileged sidecar, host users (Docker parity)       | Works today. Every agent becomes node root. Not offered, not even as a fallback; a cluster without user namespaces gets a refusal instead.                        |
| Unprivileged rootless + `/dev/net/tun` device plugin | The real end state. Blocked on injecting `/dev/net/tun` (e.g. squat/generic-device-plugin) and Unconfined seccomp on the sidecar. Phase 4.                        |
| gVisor via the Talos extension                       | Docker inside runsc needs `--iptables=false`, so `-p` port publishing breaks and only host networking works. Breaks compose and Mend's dial chain. No.            |
| Kata Containers via the Talos extension              | Strongest boundary, and nested virt is available (`vmx` in the VMs). Needs a node reinstall with a new schematic and a RuntimeClass. Worth a later spike, not v1. |
| Per-node shared daemon (DaemonSet + socket)          | Cross-workspace isolation is zero and it mounts a socket the platform promised never to mount. No.                                                                |
| Sysbox                                               | Not available on Talos.                                                                                                                                           |

## Files to modify

### sealant (the bulk)

1. `packages/workspaces/src/runtime/kubernetes/config.ts` (schema `:105-160`, env type `:178-200`,
   loader `:231-333`). Add `SEALANT_K8S_DOCKER_ENABLED`, `SEALANT_K8S_DOCKER_IMAGE` (default
   `docker:28.3.3-dind-rootless`), `SEALANT_K8S_DOCKER_GRAPH_SIZE` (default `20Gi`),
   `SEALANT_K8S_DOCKER_{CPU,MEMORY}_{REQUEST,LIMIT}`.
2. `packages/workspaces/src/runtime/kubernetes/adapter.ts:190-197`. Replace the unconditional
   refusal with "refused unless `config.docker.enabled`". Same function is re-checked at launch
   (`:306`). `describePodProblem` (`:230-249`) must name which container failed now that there are
   two. `#awaitRunning` (`:635-664`) should treat the sidecar's startup failure as a launch failure
   with the sidecar's last log lines.
3. `packages/workspaces/src/runtime/kubernetes/manifests.ts`. In `buildPod` (`:382-487`) add
   `hostUsers`, `hostAliases`, the init sidecar, the two volumes and the workspace mount. Put
   `DOCKER_HOST` and `DOCKER_TLS_CERTDIR` in `plainEnvEntries` (`:108-162`) at the adapter-owned
   layer; both names are already reserved (`api-contracts/src/workspace-environment.ts:80-89`), so
   no caller can shadow them. Give the sidecar its own securityContext constant, not
   `WORKSPACE_CAPABILITIES`.
4. Tests. `adapter.test.ts:139-144` (the pinned refusal becomes two cases), `manifests.test.ts`
   (`:203-240`, `:269`, `:312-327` pin the exact volumes array; add a Docker-enabled snapshot).
5. `deploy/helm/sealant/values.yaml:87-131` and `templates/worker.yaml:34-76`. New
   `workspaces.docker.{enabled,image,graphSize,resources}` block, passed through as the env above.
   Document in the `podSecurityEnforce` comment that Docker requires `privileged` on the workspace
   namespace (the default already is).
6. `deploy/helm/sealant/templates/networkpolicies/workspaces.yaml`. No rule change needed for Docker
   Hub (covered by `0.0.0.0/0`). Add a comment that nested-container egress is the Pod's egress, and
   that an out-of-cluster registry in a private range needs a `workspaceEgressCidrs` entry.
7. `packages/api-contracts/src/core-api/workspaces.ts`. A `WorkspaceDockerServiceUnsupportedError`
   with a stable `code: "workspace-docker-unsupported"` (422), modelled on
   `WorkspaceRuntimeEnvReferencesUnsupportedError` (`:344-361`), raised at `POST /v1/workspaces`
   when the selected runtime cannot honour `services.docker`. Refusal helper next to
   `apps/api/src/routes/workspaces/cluster-env-sources.ts`. This is what lets Mend fail fast and
   show a sentence instead of a stack trace.
8. E2E. New `packages/workspaces/src/kubernetes/docker-service.e2e.ts`, picked up by the existing
   `test:e2e src/kubernetes` step. Assert over the control channel what the Docker e2e asserts over
   `docker exec`: `docker run --rm alpine:3.20 echo nested-ok` prints `nested-ok`, plus a compose
   file with a published port reachable at `127.0.0.1` and at `docker`. Check the kind node image
   ships containerd 2.x (kind 0.27 does) and that the runner kernel is 6.3+ (Ubuntu 24.04 is 6.8).
9. Docs. `apps/docs/contents/guides/kubernetes.md:16-27` (prereqs: user namespaces on workspace
   nodes, not only build nodes; containerd 2.0+; kernel 6.3+) and `:117-119` (drop the limit, add
   the cgroup and disk notes). `docs/kubernetes-support-design.md:177-182` and `:262-263`.
   `packages/sdk/README.md:123-125` gains the Kubernetes sentence. Changeset for `@sealant/sdk`
   (error type) and the chart.

### mend

10. Bump `@sealant/sdk` and `@sealant/api-contracts` in `pnpm-workspace.yaml` once released.
11. `packages/sessions/src/engine.ts` near `:2688`. Map `workspace-docker-unsupported` to a readable
    refusal the way `runtime-env-references-unsupported` is mapped today, so the session shows "This
    deployment's workspace runtime does not provide Docker. Turn Docker off in the workspace image,
    or ask the operator to enable `workspaces.docker`." Evidence voice, no verdict.
12. `apps/web/src/routes/settings.tsx` and `projects.$projectId_.setup.tsx`. Show that refusal
    beside the Docker switch when the last launch failed with that code. No new capability read is
    needed for v1; the typed error is the probe, as the platform's own comment argues.
13. Docs. `apps/docs/src/content/docs/operate/deploy-kubernetes.md:175` (limit becomes a
    prerequisite paragraph), `guides/workspace-images.md:74-76` (add the Kubernetes note on disk
    ceiling and cgroup limits), `docs/KUBERNETES.md`, `docs/DEPLOYMENT-STRATEGIES.md:36-38`.
14. `PLATFORM-FEEDBACK.md`. Mark the 0.23.0 capability-reporting entry partially shipped (typed
    create-time error) and add the date this lands.

### sealantd

Nothing. `DOCKER_HOST` passes its env filter, and the `docker` name resolves through `/etc/hosts`.

### This cluster (ops)

15. `~/talos-ceph/sealant-values-ceph.yaml`: `workspaces.docker.enabled: true`. Optionally
    `networkPolicies.workspaceEgressCidrs` gains `10.0.0.211/32` so nested daemons can pull from
    zot, and the sidecar gets `--insecure-registry 10.0.0.211:5000` via a daemon.json ConfigMap
    (follow-up knob).
16. Mend settings: turn the Docker switch back on for the default workspace image.
17. Disk. talos2-w3's ephemeral disk is at 79 %. Twenty-gigabyte graphs per workspace plus image
    pulls will push nodes into disk-pressure eviction. Either grow the VM disks or lower `graphSize`
    to 10Gi until they are grown.

## Pull requests and order

1. **sealant #A — Kubernetes Docker sidecar.** Items 1 to 6 and 8. One PR; the adapter change is
   useless without the chart knob and the e2e is what proves it.
2. **sealant #B — create-time refusal + docs.** Items 7 and 9. Can stack on #A. Releases SDK,
   api-contracts and chart together, as `version-packages` already does.
3. **mend #C — adopt.** Items 10 to 14. Blocked on the #B release.
4. **ops** — items 15 to 17, after #A ships in an image and the chart copy lands in
   `~/talos-ceph/chart-sealant-<version>` (same per-version copy pattern as `chart-mend-*`).

## Verification

- Unit: Pod snapshot with Docker on and off; refusal message names the values key; env layering test
  proves caller env cannot override `DOCKER_HOST`.
- E2E (kind): the two assertions in item 8, plus stop leaves no Pod behind.
- Cluster acceptance, in a real Mend session on a Docker-enabled project:
  - `docker run --rm alpine:3.20 echo nested-ok`
  - `docker compose up -d` on a repo with a published port, then `mend service add <port>` reaches
    it from the phone over the private network.
  - a testcontainers test (Postgres) passes.
  - `id -u` inside the workspace is 0; the same process on the node is not (check `ps -o uid` on the
    node via `talosctl`).
  - fill the graph past `graphSize` and confirm the session ends with a readable reason, not a hang.
- Hot pool: measure idle RSS of the sidecar per standby Pod (expect 50 to 100 MiB) and confirm the
  pool size still fits the nodes.

## Known limitations to document, not fix, in v1

- Nested `--memory` and `--cpus` are ignored. The daemon runs without cgroup delegation (kubelet and
  runc 1.3 do not chown the Pod's cgroup into the user namespace), so `docker info` reports cgroup
  driver `none`. The Pod's limits still bound everything. Fix belongs to runtime upstream, or to
  Phase 4.
- The graph is per-workspace and dies with it. Cold pulls every session. Mitigation is a
  pull-through mirror (zot can proxy Docker Hub) plus `registry-mirrors` in the daemon config.
  Docker Hub's anonymous rate limit is per egress IP, and every workspace shares the nodes' IP.
- The sidecar runs with seccomp and AppArmor off (implied by `privileged`), so kernel attack surface
  from inside the user namespace is the residual risk. The workspace container keeps
  `RuntimeDefault`.
- amd64 only, same as the Arch workspace image.

## Follow-ups

- **Phase 4, unprivileged.** Deploy a device plugin that exposes `/dev/net/tun`, then drop
  `privileged` for `NET_ADMIN`, `SYS_ADMIN` (in-namespace) and `Unconfined` seccomp on the sidecar
  only. The spike shows this is the only missing piece.
- **User namespaces for every workspace Pod**, not only Docker-enabled ones. CephFS verified; the
  e2e in #A proves Secrets and projected volumes. A separate `workspaces.userNamespaces` knob.
- **Kata spike.** If a multi-tenant Mend ever runs agents from people who do not trust each other, a
  VM boundary is the honest answer, and the hardware supports it.
- **Capability read on the SDK** (`PLATFORM-FEEDBACK.md:85-101`). The typed error is enough for now;
  a `capabilities` endpoint lets Mend hide the switch instead of explaining a refusal.

## Evidence index

- Spike Pods and checks: this session, 2026-09-03 10:40 to 11:00 UTC, namespace
  `sealant-workspaces`, all deleted; the `_spike-userns` store directory removed.
- Sealant clone: `/private/tmp/claude-503/.../scratchpad/sealant` at `c1b3c65`. Line numbers above
  refer to it.
- Cluster access: `ssh k8s-arc`, `KUBECONFIG=~/talos-ceph/kubeconfig`.
- Docker adapter sidecar: `docker-runtime-adapter.ts:46` (image pin), `:669-735`, `:1000-1015`,
  `:738-745`; golden test `docker-runtime-adapter.golden.test.ts:180-230`.
- Kubernetes adapter: `kubernetes/adapter.ts:163-226` (`supportForKubernetes`),
  `manifests.ts:382-487` (`buildPod`), `config.ts:105-333`, chart
  `deploy/helm/sealant/values.yaml:87-131`.
- Mend dial chain: `packages/sessions/src/service-host.ts:304-315`,
  `apps/api/src/routes/service-tunnel.ts:91-98`; SDK host allowlist
  `apps/api/src/routes/workspaces/workspaces.ws.ts:89-97`.
