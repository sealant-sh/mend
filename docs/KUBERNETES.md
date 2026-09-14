# Mend on Kubernetes

Cross-repo design: `sealant/docs/kubernetes-support-design.md`. This page records what Mend itself
does differently when `MEND_DEPLOYMENT_MODE=kubernetes`, and what stays the same.

## The store

Since decision 8 (2026-09-13) the session store on Kubernetes is the capture store
(`docs/adr/0002-session-capture-store.md`): a bucket — a Rook `CephObjectStore` RGW where the
cluster has one, else Garage — holds immutable content-addressed captures, and Postgres holds the
only mutable pointers (`worktree_leases`, `worktree_chain`, `captures`, `packs`, `store_refs`). A
workspace Pod materialises its worktree's head capture onto an `emptyDir` on the node's own disk,
claims the worktree's lease over the session channel, and ships captures back; the API Pod reads the
chain head through the git runner's local-path cache. Nothing is mounted into a workspace Pod from a
shared filesystem.

The **RWX `mend-store` claim is retired** as the session store. The API Pod still needs a
`ReadWriteOnce` volume at `/var/lib/mend/store` for the bare repositories it adopts and fetches, the
runner cache (`_cache/runner/<project>/repo.git`), references and the machine git key; chart 0.2.0
renders exactly that (`store.create` on the cluster's default class, 50Gi, or
`store.existingClaim`), mounts it into the API Pod alone, and mirrors nothing into the workspace
namespace — the `workspaces.volumeMappings` pairing with the Sealant chart is gone. The incident
class the shared filesystem produced (uid split, root `gc` poisoning, stale sockets,
`PLATFORM-FEEDBACK.md` 2026-08-29/30) disappears by construction; failure modes are rows in
Postgres.

`MEND_SESSION_STORE=colocated` still selects the deprecated co-located store in the server — the
table below is what it mounted, kept for an install that has not moved — and logs a warning at
start. The chart does not render it: `captureStore.sessionStore` accepts only `captured`, and an
install that has not moved stays on chart 0.1.x until it follows "Upgrade" below.

| In the workspace Pod                     | On the claim (`subPath`)              | Mode  |
| ---------------------------------------- | ------------------------------------- | ----- |
| `/workspace/repo`                        | `<project>/worktrees/session-<id>`    | rw    |
| `/var/lib/mend/store/<project>/repo.git` | `<project>/repo.git` (path-identical) | rw    |
| `/workspace/ref/<name>`                  | `_references/<name>`                  | ro    |
| `/workspace/home/<name>`                 | project folders as configured         | ro/rw |
| `/run/mend`                              | `_run/sessions/<id>` (helper scripts) | ro    |

## What changes in `kubernetes` mode

- **Session channel.** Locally, each session gets a Unix socket under
  `<store>/_run/sessions/<id>/mend.sock`, bind-mounted at `/run/mend`; possession of the socket is
  the authorisation. On Kubernetes no socket is created on the shared claim. Instead Mend listens on
  `MEND_SESSION_ENDPOINT_LISTEN` (cluster-internal Service) and advertises
  `MEND_SESSION_ENDPOINT_URL` to workspaces. Each workspace is launched with:
  - `MEND_SESSION_ENDPOINT`, `MEND_SESSION_ID` (plain env),
  - `MEND_SESSION_TOKEN` (Sealant's **secret** env channel, so the record's redactor knows it). The
    token is 32 random bytes; only its sha256 is stored (`session_channel_tokens`). It grants
    exactly what the socket grants — that one session's closures — and is revoked on stop,
    replacement and hot-pool drain. Every request, including the git `CONNECT` tunnel, is
    authenticated before the session is resolved; unknown and revoked tokens are a uniform `401`, a
    valid token for a session this instance no longer serves is `409`.
- **Helper and git shim.** `/run/mend/bin/mend` and `/run/mend/bin/mend-git-ssh` are unchanged in
  behaviour and pick the transport at runtime: the socket when `/run/mend/mend.sock` exists, else
  the endpoint. All helper commands and the full-duplex pack-byte tunnel work over both. The token
  never appears in output.
- **Health.** `GET /api/health` reports `deploymentMode`, `storeRoot` and
  `sessionChannel: { mode: "unix-socket" | "network", endpoint }`.

- **Capture routes.** The same listener serves sealantd's registrar routes (`plan.get`,
  `upload.urls`, `upload.complete`, `capture.register`, `change.summary`, `lease.heartbeat`); the
  workspace receives the endpoint and token a second time as `SEALANT_CAPTURE_ENDPOINT` /
  `SEALANT_CAPTURE_TOKEN`. Presigned bucket URLs carry `MEND_BLOB_STORE_PUBLIC_URL`, the host a
  workspace Pod resolves (the RGW or Garage Service), never `localhost`.

Everything else — launch flow, checkpoints, review, hot pool — is the same as on a single machine:
the capture store is the store there too, and `mend server setup` runs Garage beside Postgres.

## Configuration

| Variable                             | Default                 | Meaning                                                                           |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------- |
| `MEND_DEPLOYMENT_MODE`               | `local`                 | `kubernetes` disables socket creation and requires the endpoint settings below.   |
| `MEND_STORE_ROOT`                    | `~/.config/mend/store`  | The claim mount path on Kubernetes (`/var/lib/mend/store`).                       |
| `MEND_SESSION_ENDPOINT_LISTEN`       | unset                   | `host:port` for the network session channel (e.g. `0.0.0.0:3106`).                |
| `MEND_SESSION_ENDPOINT_URL`          | unset                   | What workspaces connect to (e.g. `http://mend-session.mend.svc:3106`).            |
| `MEND_SESSION_ENDPOINT_TLS_CERT/KEY` | unset                   | Optional TLS for the listener; the URL must then be `https://`.                   |
| `MEND_RUN_DIR`                       | `<store>/_run/sessions` | Override for the run dirs (tests).                                                |
| `MEND_BLOB_STORE`                    | `dir://<store>/_blobs`  | `s3://<bucket>?endpoint=<RGW or Garage>&region=<region>`; credentials in `AWS_*`. |
| `MEND_BLOB_STORE_PUBLIC_URL`         | unset                   | The bucket endpoint workspace Pods resolve; presigned URLs name it.               |
| `MEND_SESSION_STORE`                 | `captured`              | `colocated` opts back into the deprecated shared-claim store (warned at start).   |
| `MEND_CAPTURE_MULTIPART_THRESHOLD`   | 16 MiB                  | Packs at or above this go up as multipart uploads (`captureStore.multipart`).     |
| `MEND_CAPTURE_MULTIPART_PART_SIZE`   | 16 MiB                  | Part size for those uploads; S3 and R2 refuse parts under 5 MiB.                  |

The chart sets every capture variable on the API tier from `captureStore` (`values.yaml`):

| Value                                              | Renders                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captureStore.sessionStore: captured`              | `MEND_SESSION_STORE=captured`; any other value fails the render.                                                                                                                                                                                              |
| `captureStore.blobStore.fromObjectBucketClaim`     | `BUCKET_HOST/PORT/NAME` from the OBC's ConfigMap and `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY` from its Secret via `valueFrom`, then `MEND_BLOB_STORE=s3://$(BUCKET_NAME)?endpoint=<scheme>://$(BUCKET_HOST):$(BUCKET_PORT)&region=<region>&forcePathStyle=true`. |
| `captureStore.blobStore.url` + `credentialsSecret` | `MEND_BLOB_STORE=<url>` and the two `AWS_*` keys from the named Secret.                                                                                                                                                                                       |
| `captureStore.blobStore.publicUrl`                 | `MEND_BLOB_STORE_PUBLIC_URL`; empty = the same in-cluster endpoint (`<scheme>://$(BUCKET_HOST):$(BUCKET_PORT)`, or `endpoint=` of the URL).                                                                                                                   |
| `captureStore.blobStore.endpoint`                  | The API NetworkPolicy's egress rule to the bucket (namespace, port, optional Pod selector); nothing in the env.                                                                                                                                               |
| `captureStore.multipart.*`                         | The two `MEND_CAPTURE_MULTIPART_*` variables, only when set.                                                                                                                                                                                                  |

Only the deprecated co-located store needs Sealant's worker to map the claim
(`SEALANT_K8S_VOLUME_MAPPINGS` with
`{ "logicalRoot": "/var/lib/mend/store", "claimName": "mend-store" }` and
`SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/var/lib/mend/store` on the API); a capture workspace mounts
nothing from Mend.

## Replicas and recovery — stated plainly

- Run **one** API replica (`api.replicaCount: 1`). The session engine holds in-memory supervision
  (listeners, pumps, the session-channel registry). Active-active APIs need session ownership/leases
  that do not exist yet.
- The **web tier scales freely** (`web.replicaCount`): it is a stateless TanStack server plus a
  transparent `/api` proxy — no database, no store, no engine. Held connections (terminal
  WebSockets, SSE) pin to whichever web replica accepted them, which is fine: every replica proxies
  to the same API.
- A workspace Pod that is deleted and recreated on another node is a pickup (ADR-0002 "Replacement
  and pickup"): its lease lapses within 30 s, Mend confirms the Pod is gone, claims the next epoch
  and launches a replacement that materialises the head capture and resumes the harness by provider
  session id. Work since the last capture — at most the small-class cadence, 2 s quiet / 10 s while
  dirty — is gone with the process. Pod recovery is "resume from the last capture", not "migrate a
  live process".
- The network channel is cluster-internal HTTP by default; the bearer token authenticates, a
  NetworkPolicy limits who can reach the listener, and TLS is optional. That is the whole statement;
  nothing stronger is claimed.

## Install with the chart

Two things exist before `helm install`: the secret, and a bucket for the capture store.

```sh
kubectl create namespace mend
kubectl -n mend create secret generic mend-secrets \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MEND_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_SERVICE_KEY="<service key from the Sealant deployment>"
```

**The bucket, on Rook Ceph (RGW).** A `CephObjectStore` is the gateway, a bucket `StorageClass`
names it, and an `ObjectBucketClaim` in the **release namespace** makes the bucket and its
credentials. Rook answers the claim with a ConfigMap and a Secret, both named after the claim, in
the claim's namespace: `BUCKET_HOST` (the RGW Service, `rook-ceph-rgw-<store>.rook-ceph.svc`),
`BUCKET_PORT`, `BUCKET_NAME` and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. The chart reads all
five and never sees the bucket name or the keys at render time.

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata: { name: mend, namespace: rook-ceph }
spec:
  metadataPool: { failureDomain: host, replicated: { size: 3 } }
  dataPool: { failureDomain: host, replicated: { size: 3 } } # or erasureCoded
  preservePoolsOnDelete: true
  gateway: { port: 80, instances: 1 }
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: mend-bucket }
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Retain # the captures are the sessions' history; keep them past the claim
parameters: { objectStoreName: mend, objectStoreNamespace: rook-ceph }
---
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata: { name: mend-bucket, namespace: mend }
spec:
  generateBucketName: mend
  storageClassName: mend-bucket
  additionalConfig:
    # A backstop for the multipart uploads an executor abandons while Mend is down
    # (docs/DEPLOYMENT-STRATEGIES.md); Mend's hourly pass aborts them itself when up.
    bucketLifecycle: |
      { "Rules": [ { "ID": "abort-multipart", "Status": "Enabled", "Filter": { "Prefix": "" },
                     "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } } ] }
```

Then point the chart at the claim's outputs. `endpoint` is the egress rule the API tier gets; the
RGW Pods carry `app: rook-ceph-rgw` and `rook_object_store: <store>` if you want it narrower than
the namespace.

```yaml
# values.yaml
captureStore:
  blobStore:
    fromObjectBucketClaim: { configMap: mend-bucket, secret: mend-bucket }
    endpoint: { namespace: rook-ceph, port: 80 }
store:
  create: { enabled: true, storageClassName: "" } # ReadWriteOnce on the cluster default (ceph-block)
```

```sh
helm install mend deploy/helm/mend -n mend -f values.yaml
```

**The bucket, on Garage (no Rook).** Run Garage beside Mend in the release namespace on an RWO claim
— the same single-node layout the shipped bundle uses (`deploy/docker/compose.v2.yaml`) — and give
the chart its URL. Garage's secrets come from the environment; the `garage.toml` below carries none.

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: garage-config, namespace: mend }
data:
  garage.toml: |
    metadata_dir = "/var/lib/garage/meta"
    data_dir = "/var/lib/garage/data"
    db_engine = "sqlite"
    replication_factor = 1
    rpc_bind_addr = "[::]:3901"
    rpc_public_addr = "127.0.0.1:3901"
    [s3_api]
    s3_region = "garage"
    api_bind_addr = "[::]:3900"
    root_domain = ".s3.garage.localhost"
    [admin]
    api_bind_addr = "[::]:3903"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: garage-data, namespace: mend }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 200Gi } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: garage, namespace: mend }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app.kubernetes.io/name: garage } }
  template:
    metadata: { labels: { app.kubernetes.io/name: garage } }
    spec:
      containers:
        - name: garage
          image: dxflrs/garage:v2.4.1
          args: [-c, /etc/garage/garage.toml, server]
          env:
            - name: GARAGE_RPC_SECRET
              valueFrom: { secretKeyRef: { name: mend-garage-node, key: GARAGE_RPC_SECRET } }
            - name: GARAGE_ADMIN_TOKEN
              valueFrom: { secretKeyRef: { name: mend-garage-node, key: GARAGE_ADMIN_TOKEN } }
          ports: [{ containerPort: 3900, name: s3 }]
          volumeMounts:
            - { name: config, mountPath: /etc/garage }
            - { name: data, mountPath: /var/lib/garage }
      volumes:
        - { name: config, configMap: { name: garage-config } }
        - { name: data, persistentVolumeClaim: { claimName: garage-data } }
---
apiVersion: v1
kind: Service
metadata: { name: garage, namespace: mend }
spec:
  selector: { app.kubernetes.io/name: garage }
  ports: [{ name: s3, port: 3900, targetPort: s3 }]
```

```sh
kubectl -n mend create secret generic mend-garage-node \
  --from-literal=GARAGE_RPC_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GARAGE_ADMIN_TOKEN="$(openssl rand -hex 32)"
kubectl -n mend apply -f garage.yaml && kubectl -n mend rollout status deploy/garage
# Lay the node out and make the bucket and key once (the five steps of deploy/dev/garage-init.sh):
G="kubectl -n mend exec deploy/garage -- /garage -c /etc/garage/garage.toml"
NODE="$($G status | awk '/^[0-9a-f]{16}/ { print $1; exit }')"
$G layout assign -z k8s -c 200GB "$NODE" && $G layout apply --version 1
$G bucket create mend
$G key create mend-api            # prints the key id and secret once — put them in the secret:
kubectl -n mend create secret generic mend-garage \
  --from-literal=AWS_ACCESS_KEY_ID="<Key ID>" --from-literal=AWS_SECRET_ACCESS_KEY="<Secret key>"
$G bucket allow --read --write --owner mend --key mend-api
```

```yaml
# values.yaml
captureStore:
  blobStore:
    url: s3://mend?endpoint=http://garage.mend.svc:3900&region=garage
    credentialsSecret: mend-garage
    endpoint: { namespace: "", port: 3900, podSelector: { app.kubernetes.io/name: garage } }
```

Any other S3-compatible endpoint takes the same `url` + `credentialsSecret` shape; a bucket without
an `endpoint=` (an AWS-region bucket) also needs `publicUrl`, since the chart cannot derive it.

The chart renders two tiers. The **API Deployment** (`apps/api`, `MEND_MODE=all`, `Recreate`, **one
replica**) is the real Mend server: the typed contract, auth, the WebSocket data planes, the session
engine, and the workers; it mounts the store claim and the machine git key, carries the capture
store's env, and listens on `<release>-api:3101` plus the internal `<release>-session` Service for
the workspace session channel (capture routes included). The **web Deployment** (`apps/web`,
stateless, `web.replicaCount` free) serves the TanStack app and transparently proxies `/api/*` —
HTTP, SSE, and WebSocket upgrades — to the API tier, so clients keep one origin on 3105. Plus
Postgres (or `DATABASE_URL` from the secret), NetworkPolicies per tier (clients→web:3105,
workspaces→session port, API→bucket endpoint, Postgres←API only), and a PodDisruptionBudget for the
API tier. No Ingress; port-forward or bring your own.

**Pair it with the Sealant chart.** Workspace Pods reach two things in Mend's world and mount
nothing: the session channel (`<release>-session:3106`) and the bucket, whose presigned URLs name
`MEND_BLOB_STORE_PUBLIC_URL`. The Sealant chart's workspace NetworkPolicy denies private ranges by
default (`networkPolicies.workspaceEgressCidrs` excludes `10.0.0.0/8` and friends), so both must be
listed in `networkPolicies.workspaceEgressAllow` of the **Sealant** values — the chart's NOTES print
the two entries for your release:

```yaml
# sealant values.yaml
networkPolicies:
  workspaceEgressAllow:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: mend } }
      podSelector: { matchLabels: { app.kubernetes.io/name: mend } }
      port: 3106
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: rook-ceph } }
      podSelector: { matchLabels: { app: rook-ceph-rgw, rook_object_store: mend } }
      port: 80
workspaces:
  volumeMappings: [] # the RWX store mapping of chart 0.1.x is retired
```

With Garage beside Mend the second entry is the release namespace, port 3900 and the Garage Pod's
label. A workspace that cannot reach the bucket logs `capture materialize failed` at launch
("Troubleshooting").

The images come from `ghcr.io/sealant-sh/mend` (`.github/workflows/image.yml`).

## Adopting projects (git auth)

The server clones and fetches; a Pod has no ambient git identity, so `--auth ambient` (the default,
right for a laptop) fails on Kubernetes with "could not read Username" / "permission denied". Use
the machine key instead:

```sh
mend keys init                                   # prints the server's public key
# add it as a deploy key (or to a machine user) on the git host, then:
mend adopt git@github.com:you/repo.git --auth mend-key
```

The key lives on the store claim (`MEND_KEYS_ROOT`, mounted from the claim's `.mend-keys` subPath),
so it survives Pod replacement. `mend connect github` is unrelated: connected accounts provision the
_agent's_ credentials inside session workspaces, never the server's git access. `--auth bridge`
(`mend keys share`) also works when you want adoption signed by your own local ssh-agent instead of
a deploy key.

## Reaching supervised Services

`mend service run/add` binds its listeners on the **server's** interfaces — operator policy
(`MEND_SERVICE_HOSTS`, loopback by default), same as on a plain host. Inside a Pod the loopback
default means Services answer only in-Pod; to reach them from your network, widen the policy and
expose the range:

```yaml
serviceHost:
  bindAddresses: ["podIP"]
  portMin: 43100
  portMax: 43119 # keep it narrow — each port is one entry on the exposure Service
  expose:
    enabled: true
    service: { type: LoadBalancer }
```

These ports carry no Mend auth (by design, since #45): reachability is the gate. The chart applies
`networkPolicies.clientCidrs` to the exposed range; put the LB on a private network you trust (a
tailnet, a VPN) or leave `expose` off.

## Upgrade

`helm upgrade mend deploy/helm/mend -n mend -f values.yaml`. Migrations run at process start (the
`mend_migrations` table) inside a transaction, so the first Pod of the new version migrates and the
rest wait on the lock. The worker is `Recreate`: sessions are re-attached by the boot reconciliation
(hot-pool sweep, socket re-staging, token verification from the hash) — the workspaces themselves
keep running in Sealant.

**From chart 0.1.x (the RWX co-located store).** Chart 0.2.0 requires a bucket and renders no
co-located store, so the upgrade is: stop sessions, add the bucket, upgrade with the old claim still
mounted, and let the worktrees backfill.

1. Stop every running session (`mend stop`, or the dashboard); a co-located worktree has no capture
   yet, and the backfill below reads its directory at rest.
2. Make the bucket (RGW or Garage above) and add the `captureStore` values.
3. Keep `store.existingClaim: mend-store` for the upgrade: the old RWX claim still holds the bare
   repositories, the runner cache, the machine key and every worktree directory, and an RWX claim
   mounts fine as the API Pod's only volume. Run `helm upgrade`. A worktree that still has a
   directory on the claim is **backfilled at its first launch** (#235, ADR-0002 decision 24):
   capture 0 is a final co-located checkpoint of the directory's current files, uncommitted edits
   included, so the work rides into the bucket and the directory is not read again. No separate
   migrate step.
4. Drop the Sealant-side mapping: `workspaces.volumeMappings: []` and the two `workspaceEgressAllow`
   entries in the Sealant values, then `helm upgrade` Sealant. The mirrored `mend-store` claim in
   the workspace namespace (`sealant-workspaces`) is no longer needed — delete it once no workspace
   Pod mounts it (`kubectl -n sealant-workspaces get pods -o jsonpath='{..claimName}'`).
5. Optional, once every worktree you care about has launched once: move the API Pod off the RWX
   claim. Scale the API to 0, copy `/var/lib/mend/store` (everything but `*/worktrees/` and `_run/`)
   and `.mend-keys` from the old claim onto a new RWO claim (a Job that mounts both), point
   `store.existingClaim` at it or switch to `store.create`, scale back up, and keep the old claim
   read-only for a while before deleting it. Nothing in the capture store depends on it.

## Roll back

`helm rollback mend <revision> -n mend`. Migrations are forward-only TypeScript effects; roll back
only to a version whose schema the data still satisfies (the CHANGELOG marks breaking migrations).
Tokens issued by the newer version remain valid to an older one as long as `session_channel_tokens`
exists (0039+).

## Troubleshooting

| Symptom                                                                                  | Where to look                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mend starts with `MEND_DEPLOYMENT_MODE=kubernetes requires MEND_SESSION_ENDPOINT_LISTEN` | The worker needs the listen address and the advertised URL; the chart sets both from `sessionChannel`.                                                         |
| `GET /api/health` shows `sessionChannel.mode: unix-socket` on Kubernetes                 | The endpoint env is missing on that Pod (the web tier reports `unix-socket` by design — only the worker listens).                                              |
| `mend service list` in a workspace prints `no session channel in this workspace`         | The workspace was launched without `MEND_SESSION_ENDPOINT`/`MEND_SESSION_ID`/`MEND_SESSION_TOKEN` — the worker that provisioned it had no endpoint configured. |
| `the session token was not accepted`                                                     | The token was revoked (workspace stopped/replaced) or the session row was re-provisioned; relaunch the session.                                                |
| `this session is not live on this Mend instance`                                         | The API tier restarted and has not re-registered the session yet (boot sweep), or a second API replica is running — keep `api.replicaCount: 1`.                |
| The workspace log says `capture plan.get failed` or `capture materialize failed`         | The Pod could not reach `MEND_SESSION_ENDPOINT_URL` or the host in a presigned URL (`MEND_BLOB_STORE_PUBLIC_URL`); both must resolve from the workspace Pod.   |
| Launch fails in Sealant with `mount source … is not under any configured logical root`   | Deprecated co-located store only: the Sealant worker's `SEALANT_K8S_VOLUME_MAPPINGS` must include `MEND_STORE_ROOT`.                                           |
| Git in the workspace says `fatal: not a git repository`                                  | Deprecated co-located store only: the common dir was not mounted path-identically at the same absolute path.                                                   |
