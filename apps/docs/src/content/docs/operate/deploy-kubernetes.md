---
title: Deploy on Kubernetes
description: Run the Mend server and Sealant control plane on a Kubernetes cluster with Helm.
sidebar:
  order: 2
---

Kubernetes is the third deployment tier, after [your own machine](/getting-started/install/) and
[a VPS](/operate/deploy-vps/). The product behaves the same; what changes is where things run. The
Mend chart (`deploy/helm/mend`, chart 0.3.0) renders an API tier and a web tier, session workspaces
are Pods that Sealant creates on any node, and sessions live in the capture store: an S3-compatible
bucket for the captured work and Postgres for the pointers to it.

A workspace Pod lays its worktree's newest capture down on the node's own disk, works there, and
ships captures back to the bucket. It mounts nothing from Mend. Only the API Pod mounts a volume: a
ReadWriteOnce claim for the bare repositories, the runner cache, references and the Mend git keys.

The maintainer record behind this page is
[`docs/KUBERNETES.md`](https://github.com/sealant-sh/mend/blob/main/docs/KUBERNETES.md). It holds
the full Rook and Garage manifests, the upgrade path from chart 0.1.x, and the troubleshooting
table. The charts live at `deploy/helm/mend` in this repository and `deploy/helm/sealant` in the
[Sealant repository](https://github.com/sealant-sh/sealant).

## First, meet Sealant

Mend is built on Sealant, a separate workspace platform. Sealant creates the isolated environments
agents run in, builds their images, supervises their processes, and records what happens inside
them. Mend never touches a container or Pod itself; it asks Sealant through the platform's SDK.

On the single-host tiers `mend server setup` ships Sealant inside the Mend application image and you
can ignore it. On Kubernetes you install it yourself, before Mend, because Mend refuses to run
without a platform to talk to. Sealant's chart brings its own control plane (an API, a worker that
creates workspace Pods, a web app, Postgres, an image registry, an SSH gateway), plus the namespace
workspace Pods run in, the certificate authority that secures their control channels, and the narrow
RBAC the worker needs.

## What you need

- A StorageClass that provisions ReadWriteOnce claims. The cluster default is enough: the API Pod's
  store claim and Postgres are the only volumes the chart asks for.
- An S3-compatible bucket that both the API Pod and workspace Pods can reach: a Rook Ceph object
  store through an ObjectBucketClaim, Garage running beside Mend, or any other S3-compatible
  endpoint.
- cert-manager in the cluster. Sealant uses it to run an internal certificate authority for the
  mutual-TLS channels between its control plane and workspace Pods.
- `kubectl` and `helm` pointed at the cluster, and both repositories cloned. The charts ship in the
  repositories; there is no chart registry yet.

## Step 1: install Sealant

Create its namespace and secrets. `SEALANT_SERVICE_KEYS` lists every key allowed to call the Sealant
API as a service: the web app's key and Mend's. Keep the Mend key; it goes into Mend's secret in
step 3.

```sh
WEB_KEY="$(openssl rand -hex 32)"
MEND_KEY="$(openssl rand -hex 32)"
kubectl create namespace sealant
kubectl -n sealant create secret generic sealant-secrets \
  --from-literal=SEALANT_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=WORKSPACE_SSH_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_CREDENTIALS_KEY="$(openssl rand -base64 32)" \
  --from-literal=SEALANT_WEB_SERVICE_KEY="$WEB_KEY" \
  --from-literal=SEALANT_SERVICE_KEYS="$WEB_KEY,$MEND_KEY"
```

Workspace Pods reach two things in Mend's world: the session channel on the Mend API Pod, and the
bucket. Sealant's workspace NetworkPolicy denies private address ranges by default, so both go in
Sealant's `networkPolicies.workspaceEgressAllow`. Clear the store mapping that older Mend charts
needed:

```yaml
# sealant-values.yaml
networkPolicies:
  workspaceEgressAllow:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: mend } }
      podSelector: { matchLabels: { app.kubernetes.io/name: mend } }
      port: 3106
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: rook-ceph } }
      podSelector: { matchLabels: { app: rook-ceph-rgw, rook_object_store: mend } }
      port: 8080 # the RGW Pod port, not its Service's 80
workspaces:
  volumeMappings: []
```

With Garage beside Mend, the second entry names the Mend namespace, port 3900 and the Garage Pod's
label. The Mend chart's install notes print both entries for your release.

```sh
helm install sealant deploy/helm/sealant -n sealant -f sealant-values.yaml
kubectl -n sealant get pods
```

In-cluster, Mend reaches the Sealant API at `http://sealant-api.sealant.svc:4000`, the Mend chart's
default `sealant.baseUrl`.

The [Sealant repository](https://github.com/sealant-sh/sealant) documents the rest of this half: Pod
Security levels for the workspace namespace, the BuildKit prerequisites for image builds (including
the user-namespace sysctl hardened distributions need), registry trust, and its troubleshooting
table. Read it before installing on a hardened cluster.

## Step 2: make the bucket

Point the chart at the bucket in `captureStore.blobStore`, one of three ways:

- `fromObjectBucketClaim`: a Rook ObjectBucketClaim in the Mend namespace. Rook answers it with a
  ConfigMap and a Secret named after the claim, and the chart reads the bucket host, port, name and
  keys from them at container start.
- `url` with `credentialsSecret`: any S3-compatible endpoint, such as Garage, written as
  `s3://<bucket>?endpoint=<url>&region=<name>&forcePathStyle=<bool>`, with a Secret holding
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- `url` with `useDefaultCredentials: true`: the AWS SDK's default credential chain, for example IRSA
  through a service account you precreate and name in `api.serviceAccountName`. The chart renders no
  static key.

On Rook Ceph:

```yaml
captureStore:
  blobStore:
    fromObjectBucketClaim: { configMap: mend-bucket, secret: mend-bucket }
    endpoint: { namespace: rook-ceph, port: 80, podPort: 8080 }
```

With Garage in the Mend namespace:

```yaml
captureStore:
  blobStore:
    url: s3://mend?endpoint=http://garage.mend.svc:3900&region=garage
    credentialsSecret: mend-garage
    endpoint:
      { namespace: "", port: 3900, podPort: 3900, podSelector: { app.kubernetes.io/name: garage } }
```

`endpoint` is the API tier's egress rule to the bucket. `podPort` is the port the bucket's container
listens on, because a NetworkPolicy matches the Pod port after the Service translates it; Rook's
gateway Service maps 80 to 8080. Presigned URLs name `publicUrl`, which defaults to the same
in-cluster endpoint; a bucket URL without `endpoint=` (an AWS-region bucket) needs it set. The
[maintainer record](https://github.com/sealant-sh/mend/blob/main/docs/KUBERNETES.md#install-with-the-chart)
has the CephObjectStore, bucket StorageClass and ObjectBucketClaim manifests, and a Garage
Deployment with the commands that create its bucket and key.

## Step 3: install Mend

Create the namespace and secret. `SEALANT_SERVICE_KEY` is the Mend key you listed in
`SEALANT_SERVICE_KEYS` in step 1; with it Mend authenticates as a service while stating which user
each request acts for.

```sh
kubectl create namespace mend
kubectl -n mend create secret generic mend-secrets \
  --from-literal=MEND_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_SERVICE_KEY="$MEND_KEY"
```

Your values file carries the cluster facts the chart does not know. Two choices have no default and
the chart refuses to render without them:

- The store claim: `store.create.enabled: true` for a fresh install, or `store.existingClaim` for an
  upgrade that keeps an existing claim.
- How workspaces reach the session channel: `exposure.executorNetwork: private` states that they
  reach it over a network you control (the cluster network, a VPC), so plain HTTP may be used; or
  `sessionChannel.tls.enabled: true` with a TLS Secret serves it over HTTPS. The workspace daemon in
  Sealant 0.34 and later refuses a plain-HTTP channel without that statement.

```yaml
# mend-values.yaml
store:
  create: { enabled: true }
captureStore:
  blobStore:
    fromObjectBucketClaim: { configMap: mend-bucket, secret: mend-bucket }
    endpoint: { namespace: rook-ceph, port: 80, podPort: 8080 }
exposure:
  mode: private
  executorNetwork: private
web:
  appUrl: http://localhost:3105
```

```sh
helm install mend deploy/helm/mend -n mend -f mend-values.yaml
```

The chart creates:

- `<release>-api`: the Mend server (`apps/api`, `MEND_MODE=all`) from the `mend-api` image. It holds
  the typed API, authentication, the WebSocket data planes, the session engine and the workers. One
  replica with the `Recreate` strategy, because the engine keeps live state in memory. It mounts the
  store claim and serves the session channel on the `<release>-session` Service, port 3106.
- `<release>-web`: the web app (`apps/web`) from the `mend-web` image. It serves the interface and
  proxies `/api`, the event stream and WebSocket upgrades to the API tier, so clients keep one
  origin on port 3105. It is stateless; scale it with `web.replicaCount`.
- Postgres (or `DATABASE_URL` from the secret with `postgres.enabled: false`), NetworkPolicies per
  tier, a PodDisruptionBudget, and optionally an Ingress.

Until you add an Ingress, reach the web tier with a port-forward:

```sh
kubectl -n mend port-forward svc/mend-web 3105:3105
```

Open the UI, create the first account (registration closes after it, and everyone else joins by
invitation), and run `mend login --url` from your machine. From there the
[VPS page's](/operate/deploy-vps/) remote workflow applies unchanged.

## Expose the web tier

`exposure.mode` is your statement of how the instance is reached: `loopback`, `private` (the
default) or `public`. It becomes `MEND_EXPOSURE` on the API tier. Mend cannot observe what is
published in front of its Pods, so `mend operator exposure` reports what it observed beside what you
declared, and `public` refuses to start while an item of the public exposure gate that Mend can
observe is open. The related values:

| Value                        | Renders                    | Meaning                                                                                                                     |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `exposure.mode`              | `MEND_EXPOSURE`            | `loopback`, `private` or `public`                                                                                           |
| `exposure.executorNetwork`   | `MEND_EXECUTOR_NETWORK`    | Empty or `private`; see step 3                                                                                              |
| `exposure.refuseUrlBearers`  | `MEND_URL_BEARERS=refuse`  | Refuse a session or device bearer in a URL; `public` needs it on                                                            |
| `exposure.declared`          | `MEND_EXPOSURE_DECLARED`   | `core-private` and `edge-tls`, the two gate items only you can verify from outside; reported as declared, never as observed |
| `exposure.reassessedVersion` | `MEND_EXPOSURE_REASSESSED` | The version you recorded an independent security reassessment of; it counts only while it equals the running version        |

`ingress.enabled: true` renders one Ingress: one host, TLS, and the web Service only. The API,
Sealant, the session channel and supervised Services are never routed. The chart renders the Ingress
and nothing else; the controller and the certificate issuer are your cluster's.

```yaml
web:
  appUrl: https://mend.example.com # exactly https://<ingress.host>, or the render fails
ingress:
  enabled: true
  className: nginx
  host: mend.example.com
  tls: { secretName: mend-tls }
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-body-size: 32m
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  controller:
    namespace: ingress-nginx
    podLabels: { app.kubernetes.io/name: ingress-nginx }
api:
  trustedProxyCidrs: ["10.244.0.0/16"] # the controller's Pods and the web tier, nothing wider
```

With NetworkPolicies on, `ingress.controller.namespace` and `podLabels` are required: the web policy
admits the controller's Pods by namespace and label in one selector. What the chart cannot check:

- The controller must append the client address to `X-Forwarded-For` and not pass one a client sent.
  Request budgets count the address that `api.trustedProxyCidrs` lets through.
- `/api/tty`, `/api/service-tunnel`, `/api/keys/bridge/ws` and `/tty-embed` carry a single-use
  upgrade ticket in the query string, and `/pair` a pairing code. Keep query strings on those paths
  out of the controller's logs.
- A controller that buffers responses breaks the `/api/events` stream. The timeouts above keep
  terminals and the event stream open.
- Mend accepts request bodies up to 1 MiB, and 24 MiB on routes that take a file. A folder upload
  sends about 5.5 MiB per request and a pasted image up to 8 MiB, so an ingress cap below that
  refuses them with 413 before Mend sees them. ingress-nginx caps bodies at 1 MiB unless
  `proxy-body-size` is set.

Read [Exposure and budgets](/operate/exposure/) for the gate items and what each one means.

## The session channel

Workspaces call the API Pod on the `<release>-session` Service (`sessionChannel.port`, default 3106)
with a per-session token. The Service is `ClusterIP` by default, or `NodePort` with an explicit port
in 30000 to 32767 when workspaces run outside the cluster's DNS. `sessionChannel.advertisedUrl`
names the address such workspaces use, and `networkPolicies.sessionChannelCidrs` admits their source
networks to that port only.

`sessionChannel.tls.enabled` with `secretName` serves the channel over HTTPS; the advertised URL's
scheme must match. When a private CA signed the certificate, `sessionChannel.tls.ca.secretName`
hands its roots to every workspace so the daemon verifies the channel against them.

## Server settings through `extraEnv`

`extraEnv` adds plain environment variables to the API tier only. Use it for server settings the
chart has no value for, such as tenancy, budgets and database pool caps:

```yaml
extraEnv:
  - { name: MEND_TENANCY, value: single }
  - { name: MEND_DATABASE_POOL_MAX, value: "10" }
```

`MEND_TENANCY=multi` refuses to start until every item of the multi mode gate passes;
`mend operator gate` lists each item and what would satisfy it. Browser origins are set with
`web.appUrl` and `web.allowedOrigins`, which reach both tiers.
[Server environment](/reference/server-environment/) lists every variable.

## Git access

The server clones and fetches as the user who adopts. A Pod has no ambient Git identity, so
`--auth ambient` fails there. Use your Mend key or the bridge:

```sh
mend keys init                 # your Mend key, held on the server
mend keys show                 # add it to your Git account's SSH keys
mend adopt git@github.com:acme/api.git --auth mend-key
# or keep the key on your laptop:
mend adopt git@github.com:acme/api.git --auth bridge
```

Each user has their own Mend key. The keys live on the store claim, mounted at a path of their own,
so they survive Pod replacement. `mend connect github` is unrelated: connected accounts provide the
agent's credentials inside workspaces, not the server's Git access. See
[Git access](/guides/git-access/).

## Reaching development Services

`mend service connect` is the deployment-independent path: it binds the Service's port on your
machine's loopback and carries every connection over an authenticated WebSocket to the Mend API,
with no cluster networking and no unauthenticated ports. `mend attach`, `mend codex`, `mend claude`
and the dashboard do this on their own for the attached session's Services declared `--http` or
`--https`.

```sh
mend service connect web --port 43100
curl http://127.0.0.1:43100
```

Operators who trust a private network can also expose a port range on the cluster with the chart's
`serviceHost` values (bind addresses, port range, an enumerated-port Service). Those ports carry no
Mend authentication; reachability is the gate, and the chart applies your
`networkPolicies.clientCidrs` to the range. It is off by default.

## Workspace environment from the cluster

Projects on a Kubernetes install can hold cluster bindings: names of Secrets and ConfigMaps in the
workspaces namespace whose keys the Sealant worker resolves into workspace environment at each fresh
launch. Mend stores the names only, never the contents, so rotating a value is a `kubectl` operation
and nothing crosses Mend's database. Only objects the operator labeled for workspace environment
resolve, and workspace service accounts requested by projects must be on the operator allowlist;
both are Sealant-side controls, documented with its chart.

At each fresh workspace launch, Mend forwards a project's bindings verbatim as the workspace's
environment sources and the worker resolves the objects server-side; a requested service account
rides the same launch as the Pod identity. Read
[Environment variables and secrets](/guides/environment-variables/#cluster-bindings) for the
project-side view.

## Upgrade and roll back

`helm upgrade` replaces the API Pod (`Recreate`). Database migrations run when the new server
starts, before it serves. Running workspace Pods are Sealant's and keep running across a Mend
upgrade; the new API Pod picks their sessions up again. Migrations are forward-only: a Helm rollback
re-renders old manifests, but old application code must still be compatible with the current schema,
so check release notes before rolling back.

Chart 0.3.x with Sealant 0.34 or later needs `exposure.executorNetwork: private` or
`sessionChannel.tls.enabled` before the upgrade; the chart refuses to render otherwise. An install
still on chart 0.1.x (the shared ReadWriteMany store) has its own path: stop sessions, add the
bucket, upgrade with `store.existingClaim` pointing at the old claim, and each worktree is
backfilled into the capture store at its first launch. Follow the
[maintainer record's upgrade section](https://github.com/sealant-sh/mend/blob/main/docs/KUBERNETES.md#upgrade)
step by step.

## Current limits

- One API replica. The web tier scales; the session engine does not run active-active yet.
- A workspace Pod that vanishes without exiting (node loss, a forced delete) is picked up on the
  next resume from its last capture. Work since that capture, a few seconds at most, is lost with
  the process. A plain `kubectl delete pod` is a planned stop: the workspace flushes a final capture
  and the session settles `completed`.
- The Service tunnel is TCP-only; UDP Services need the operator exposure path.
- Workspace-scoped Docker (`services.docker`) needs `workspaces.docker.enabled` on the Sealant
  chart: the daemon then runs as a rootless sidecar of a user-namespaced workspace Pod, which needs
  Kubernetes 1.33+, containerd 2.0+ and kernel 6.3+. Until the operator enables it, a launch with
  Docker on is refused at create and the session shows the refusal; turn Docker off in the workspace
  environment for projects that run there. Inside it, nested `--memory`/`--cpus` limits are ignored
  and the image graph is a per-workspace budget (`workspaces.docker.graphSize`) that pulls cold
  every session.

When something fails, split the diagnosis at the product boundary: workspace Pods, image builds,
certificates, and RBAC are Sealant's half (its guide has the troubleshooting table); sessions,
captures, adoption, review, and Services are Mend's, and the
[maintainer record](https://github.com/sealant-sh/mend/blob/main/docs/KUBERNETES.md#troubleshooting)
lists their symptoms.
