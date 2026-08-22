# Mend on Kubernetes

Cross-repo design: `sealant/docs/kubernetes-support-design.md`. This page records what Mend itself
does differently when `MEND_DEPLOYMENT_MODE=kubernetes`, and what stays the same.

## The invariant

Mend is code-co-located. The central store — bare repositories, linked worktrees, references,
checkpoint refs, harvested harness state — lives on **one RWX, POSIX-semantics
PersistentVolumeClaim** mounted into the Mend Pod at `/var/lib/mend/store`
(`MEND_STORE_ROOT=/var/lib/mend/store`). Workspace Pods, scheduled on any node, mount
_subdirectories_ of that same claim:

| In the workspace Pod                     | On the claim (`subPath`)              | Mode  |
| ---------------------------------------- | ------------------------------------- | ----- |
| `/workspace/repo`                        | `<project>/worktrees/session-<id>`    | rw    |
| `/var/lib/mend/store/<project>/repo.git` | `<project>/repo.git` (path-identical) | rw    |
| `/workspace/ref/<name>`                  | `_references/<name>`                  | ro    |
| `/workspace/home/<name>`                 | project folders as configured         | ro/rw |
| `/run/mend`                              | `_run/sessions/<id>` (helper scripts) | ro    |

The git common directory is mounted at the **same absolute path** the worktree's `.git` pointer
names, so `git` inside the Pod resolves the linked worktree exactly as Mend does. Nothing is cloned
into the Pod, nothing is copied to an `emptyDir`, nothing is synced back: an agent's edit is a write
to the same inode Mend reads.

The claim is a generic contract. Longhorn, CephFS, NFS, EFS and other RWX CSI drivers are operator
choices; Mend names none of them. Semantics that matter: POSIX rename/unlink, `fsync`, and `O_EXCL`
create (git's lock files).

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

Everything else — launch flow, checkpoints, review, hot pool — is unchanged. In `local` mode (the
default) none of the above activates and the installer, Docker Compose and the per-session socket
behave exactly as before.

## Configuration

| Variable                             | Default                 | Meaning                                                                         |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------- |
| `MEND_DEPLOYMENT_MODE`               | `local`                 | `kubernetes` disables socket creation and requires the endpoint settings below. |
| `MEND_STORE_ROOT`                    | `~/.config/mend/store`  | The claim mount path on Kubernetes (`/var/lib/mend/store`).                     |
| `MEND_SESSION_ENDPOINT_LISTEN`       | unset                   | `host:port` for the network session channel (e.g. `0.0.0.0:3106`).              |
| `MEND_SESSION_ENDPOINT_URL`          | unset                   | What workspaces connect to (e.g. `http://mend-session.mend.svc:3106`).          |
| `MEND_SESSION_ENDPOINT_TLS_CERT/KEY` | unset                   | Optional TLS for the listener; the URL must then be `https://`.                 |
| `MEND_RUN_DIR`                       | `<store>/_run/sessions` | Override for the run dirs (tests).                                              |

Sealant's worker must map the same path: `SEALANT_K8S_VOLUME_MAPPINGS` includes
`{ "logicalRoot": "/var/lib/mend/store", "claimName": "mend-store" }`, and
`SEALANT_MOUNT_ALLOWED_STORE_ROOTS=/var/lib/mend/store` on the API.

## Replicas and recovery — stated plainly

- Run **one** Mend worker replica. The session engine holds in-memory supervision (listeners, pumps,
  the session-channel registry). Active-active workers need session ownership/leases that do not
  exist yet; the chart pins `worker.replicaCount: 1`. The web/API tier can scale once the engine is
  split out — not claimed today.
- A workspace Pod that is deleted and recreated on another node mounts the same worktree and
  continues from the durable state: the worktree files, checkpoint refs and harvested harness state.
  **The process that was in RAM at the moment the node died is gone.** Pod recovery is "resume from
  durable state", not "migrate a live process".
- The network channel is cluster-internal HTTP by default; the bearer token authenticates, a
  NetworkPolicy limits who can reach the listener, and TLS is optional. That is the whole statement;
  nothing stronger is claimed.
