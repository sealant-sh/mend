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
runner cache (`_cache/runner/<project>/repo.git`), references and the machine git key; the chart's
`store.existingClaim` / `store.create` values still render it and still say RWX — narrowing them to
RWO and dropping `SEALANT_K8S_VOLUME_MAPPINGS` for the store are chart follow-ups. The incident
class the shared filesystem produced (uid split, root `gc` poisoning, stale sockets,
`PLATFORM-FEEDBACK.md` 2026-08-29/30) disappears by construction; failure modes are rows in
Postgres.

`MEND_SESSION_STORE=colocated` still selects the deprecated co-located store — the table below is
what it mounted, kept for an install that has not moved — and logs a warning at start:

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

```sh
kubectl create namespace mend
kubectl -n mend create secret generic mend-secrets \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MEND_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_SERVICE_KEY="<service key from the Sealant deployment>"
# A bucket for the capture store (Rook RGW or Garage) and its credentials in the same secret:
#   MEND_BLOB_STORE=s3://mend?endpoint=http://rook-ceph-rgw-store.rook-ceph.svc&region=us-east-1
#   MEND_BLOB_STORE_PUBLIC_URL=http://rook-ceph-rgw-store.rook-ceph.svc
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# One claim for the API Pod's store directory (bare repositories, runner cache; RWO is enough
# since decision 8 — the chart still says RWX, a follow-up). Create it or let the chart create it:
helm install mend deploy/helm/mend -n mend \
  --set store.create.enabled=true --set store.create.storageClassName=<a storage class>
# …or, with an existing claim:
helm install mend deploy/helm/mend -n mend --set store.existingClaim=mend-store
```

The chart renders two tiers. The **API Deployment** (`apps/api`, `MEND_MODE=all`, `Recreate`, **one
replica**) is the real Mend server: the typed contract, auth, the WebSocket data planes, the session
engine, and the workers; it mounts the store claim and the machine git key, and listens on
`<release>-api:3101` plus the internal `<release>-session` Service for the workspace session
channel. The **web Deployment** (`apps/web`, stateless, `web.replicaCount` free) serves the TanStack
app and transparently proxies `/api/*` — HTTP, SSE, and WebSocket upgrades — to the API tier, so
clients keep one origin on 3105. Plus Postgres (or `DATABASE_URL` from the secret), NetworkPolicies
per tier (clients→web:3105, workspaces→session port, Postgres←API only), and a PodDisruptionBudget
for the API tier. No Ingress; port-forward or bring your own.

Pair it with the Sealant chart: workspace Pods need egress to the Mend session port and to the
bucket endpoint (`networkPolicies.workspaceEgressAllow`); no claim mapping is needed for the capture
store (only the deprecated co-located store maps `workspaces.volumeMappings`).

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
