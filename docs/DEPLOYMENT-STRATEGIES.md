# Deployment strategies

Cross-repo design; the Sealant half lives in `sealant/docs/kubernetes-support-design.md` and the
`cloudflare` runtime adapter series (sealant PRs #197–#202). `docs/KUBERNETES.md` describes the
`kubernetes` strategy in operational detail; this page names the model those pages instantiate, so
the next strategy is an adapter, not an archaeology project.

## The invariant, stated once

> Every session has exactly one authoritative mutable workspace. File mutations, checkpoints, diffs,
> review comments and execution evidence are ordered against that authority, and Mend never reviews
> a stale copy.

Since decision 8 (2026-09-13, "captures everywhere from day one") the authority is the **capture
store** in every strategy: object storage holds immutable content-addressed captures, Postgres holds
the only mutable pointers, the executor is disposable compute working on its own disk, and every
read Mend serves is stamped "observed · capture n" (`docs/adr/0002-session-capture-store.md`). "Mend
and the workspace see the same POSIX worktree" — the co-located store — was the implementation
technique of the first two strategies. It is retired: `MEND_SESSION_STORE=colocated` still selects
it, with a startup warning, for an install that has not moved, and nothing above the ports below may
assume it.

## Stable programs × deployment strategies

The programs are fixed: Mend API+engine, Mend web, Sealant API, Sealant worker, sealantd. A
deployment strategy is a **named, tested composition** that supplies each program's behavioral
ports. Arbitrary mix-and-match is deliberately not offered; a strategy is a coherent bundle with
known capabilities and invariants.

| Port (what exists today)                                | `local` (default)         | `kubernetes`                      | `cloudflare-hosted` (in progress)    |
| ------------------------------------------------------- | ------------------------- | --------------------------------- | ------------------------------------ |
| Workspace runtime (`RuntimeAdapter`, sealant)           | Docker container          | Workspace Pod                     | Sandbox via bridge Worker            |
| Session workspace authority (`SessionRepository`, mend) | capture store (Garage)    | capture store (RGW or Garage)     | capture store (R2)                   |
| Control transport (`SealantTarget`, sealant)            | unix socket / docker-exec | mTLS WebSocket                    | bearer-token WebSocket via bridge    |
| Session channel (mend)                                  | per-session unix socket   | authenticated network endpoint    | authenticated network endpoint       |
| Launch material (sealant `LaunchMaterialStager`)        | host directories          | Secret projection                 | inline over the bridge's HTTPS       |
| Image build (sealant `WorkspaceImageBuilder`)           | docker build/save         | rootless BuildKit Job             | prebuilt runtime class (deploy-time) |
| Run record / product store                              | Postgres                  | Postgres                          | Postgres (Hyperdrive); R2 later      |
| Service exposure                                        | loopback forwards         | forwards over the control channel | authenticated HTTP/WS previews only  |
| Bucket, executor disk                                   | Garage volume, container  | RGW/Garage, `emptyDir`            | R2, sandbox disk                     |

Since the packaging work (`mend server setup`, see `docs/SELF-HOSTING.md`), the `local` strategy
runs inside the Mend application container: the store directory and unix sockets above are container
paths under `/var/lib/mend/store` and `/run/sealant/sockets`, which Sealant's Docker volume mappings
lower onto named volumes. The bundle's bucket is a Garage container on its own volume
(`mend-garage`), initialised once by setup; the session channel listens on the Compose network as
`mend:3106` and presigned URLs name `garage:3900`. Executors reach both only when the Sealant Docker
runtime attaches workspace containers to that network — recorded as platform feedback
(`PLATFORM-FEEDBACK.md` 2026-09-13); until it ships, the bundle's workspace containers sit on the
default bridge and cannot resolve those names.

Capabilities differ per strategy and are **reported, never assumed** — sealant's `supports()`
already refuses what a runtime cannot do (the Docker service where the operator has not enabled it,
gVisor selection, mount sources on Cloudflare), the API refuses at create with a stable code
(`runtime-env-references-unsupported`, `workspace-docker-unsupported`) so nothing is queued, and
Mend's `worktreeMount` answers `undefined` everywhere but the deprecated co-located adapter. UI copy
follows the voice rules: state the observed capability gap, never a judgment.

## The two Mend-side ports

- **`SessionRepository`** (`packages/sessions/src/session-repository.ts`): the identity-keyed
  authority. `createWorktree` / `attachWorktree` / `resetWorktree` / `removeWorktreeForce` /
  `checkpoint`, keyed by project + session + worktree name. `SessionRepositoryCapturedLive`
  (`session-repository-captured.ts`) serves every strategy from the bucket and the pointer store;
  `SessionRepositoryLocalLive` is the deprecated co-located adapter. `worktreeMount` is the explicit
  co-location capability and answers `undefined` on the captured adapter.
- **`DeploymentConfig`** (`packages/store/src/deployment.ts`): the one deployment fact
  (`local | kubernetes` today) plus the session-endpoint contract. The session channel keys its
  behavior off endpoint _presence_, not the mode — that stays the rule as modes grow.

## The hosted strategy, sequenced honestly

**Tier 1 — hosted workspaces, containerized control plane (moderate).** Sealant's `cloudflare`
adapter + bridge Worker run the workspace body in Cloudflare Sandboxes while api/worker keep running
as containers against Postgres. Mend prerequisites: the `SessionRepository` hosted adapter and a
non-mount workspace source at the SDK boundary (recorded in `PLATFORM-FEEDBACK.md`). The vertical
slice to prove: adopt → session in a sandbox → live record → checkpoint → stop → restore →
reviewable diff.

**Tier 2 — Workers-native control plane (large).** Durable Object per run/session (sealant's
telemetry supervisor map and run-exec ownership are the natural DOs), Cloudflare Queues replacing
the three Sealant job queues (pg-boss in Postgres), Cron Triggers replacing the interval reapers,
Hyperdrive to Postgres (D1 cannot hold the record schema: `jsonb`, `bytea` artifacts, uint64
sequences), and a rebuilt inference path (the current engines spawn CLIs). None of this blocks
Tier 1.

**Capture store (ADR-0002, the store).** Object storage plus Postgres pointers hold the authority,
the executor works on its own disk, and Mend reads the chain head through a runner. The dev stack
(`compose.dev.yaml`) and the shipped bundle (`compose.yaml` → `deploy/docker/compose.v2.yaml`) run
Garage for it; on Kubernetes the bucket is a Rook `CephObjectStore` RGW or Garage (the chart's
`captureStore` values, `docs/KUBERNETES.md`), on Cloudflare R2. Chart 0.2.0 renders only the capture
store: the API Pod's claim is `ReadWriteOnce` and nothing is mirrored into workspace Pods; the RWX
`mend-store` claim of chart 0.1.x is retired. Packs at or above 16 MiB go up as multipart uploads
(`upload.urls` with `sizes`, then `upload.complete`; `MEND_CAPTURE_MULTIPART_THRESHOLD` /
`_PART_SIZE`). An executor that dies between its part PUTs and the complete leaves an open upload
whose parts are billed until aborted: Mend's hourly retention pass aborts every open upload under a
fenced epoch and every one older than the URL TTL plus the grace (`MULTIPART_ORPHAN_MS`), and a real
bucket should carry the matching lifecycle rule as a backstop for the hours Mend is down —
`AbortIncompleteMultipartUpload` after 1 day on S3 (bucket lifecycle configuration), R2 (object
lifecycle rules, "abort multipart uploads"), and Garage (bucket lifecycle, the same S3 rule shape).

**Correctness pre-work (done, sealant #197):** at-least-once delivery with more than one consumer
required the build-job claim to be race-free and run-exec to be at-most-once. Those hold now
regardless of strategy.

## Open design questions (decide before Tier 1 ships)

1. **Where does the git authority live on Cloudflare?** Answered by ADR-0002: in R2 as captures,
   with the chain head in Postgres and `refs/mend/checkpoints/*` in `store_refs`. What remains is
   the `cf` git cell in ops-only mode for the runner (`docs/CLOUDFLARE-HOSTED.md`).
2. **Tenancy lives in Mend, not Sealant.** Hosted Mend needs organizations, `tenant_id` ownership,
   per-tenant secrets, quotas and audit. Sealant stays the single-tenant runtime a deployment owns —
   consistent with its "self-hosted, not SaaS" positioning; hosted Mend deploys a Sealant per cell
   (or per tenant) rather than teaching Sealant multi-tenancy.
3. **Capability surfacing.** The SDK should expose what a workspace's runtime family can and cannot
   do so Mend can degrade UI honestly (no raw TCP forwards, disk ceilings, Docker off). Recorded as
   platform feedback; the typed create-time refusals are the first half of it.
