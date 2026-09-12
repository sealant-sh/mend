# Deployment strategies

Cross-repo design; the Sealant half lives in `sealant/docs/kubernetes-support-design.md` and the
`cloudflare` runtime adapter series (sealant PRs #197–#202). `docs/KUBERNETES.md` describes the
`kubernetes` strategy in operational detail; this page names the model those pages instantiate, so
the next strategy is an adapter, not an archaeology project.

## The invariant, stated once

> Every session has exactly one authoritative mutable workspace. File mutations, checkpoints, diffs,
> review comments and execution evidence are ordered against that authority, and Mend never reviews
> a stale copy.

"Mend and the workspace see the same POSIX worktree" — the co-located store — is an _implementation
technique_ that satisfies this invariant in the `local` and `kubernetes` strategies. It is not the
invariant itself, and nothing above the ports below may assume it.

## Stable programs × deployment strategies

The programs are fixed: Mend API+engine, Mend web, Sealant API, Sealant worker, sealantd. A
deployment strategy is a **named, tested composition** that supplies each program's behavioral
ports. Arbitrary mix-and-match is deliberately not offered; a strategy is a coherent bundle with
known capabilities and invariants.

| Port (what exists today)                                | `local` (default)         | `kubernetes`                      | `cloudflare-hosted` (in progress)    |
| ------------------------------------------------------- | ------------------------- | --------------------------------- | ------------------------------------ |
| Workspace runtime (`RuntimeAdapter`, sealant)           | Docker container          | Workspace Pod                     | Sandbox via bridge Worker            |
| Session workspace authority (`SessionRepository`, mend) | local git worktree        | worktree on the RWX claim         | _open design: see below_             |
| Control transport (`SealantTarget`, sealant)            | unix socket / docker-exec | mTLS WebSocket                    | bearer-token WebSocket via bridge    |
| Session channel (mend)                                  | per-session unix socket   | authenticated network endpoint    | authenticated network endpoint       |
| Launch material (sealant `LaunchMaterialStager`)        | host directories          | Secret projection                 | inline over the bridge's HTTPS       |
| Image build (sealant `WorkspaceImageBuilder`)           | docker build/save         | rootless BuildKit Job             | prebuilt runtime class (deploy-time) |
| Run record / product store                              | Postgres                  | Postgres                          | Postgres (Hyperdrive); R2 later      |
| Service exposure                                        | loopback forwards         | forwards over the control channel | authenticated HTTP/WS previews only  |

Since the packaging work (`mend server setup`, see `docs/SELF-HOSTING.md`), the `local` strategy
runs inside the Mend application container: the "host directories" and unix sockets above are
container paths under `/var/lib/mend/store` and `/run/sealant/sockets`, which Sealant 0.28's Docker
volume mappings lower onto named volumes. The invariant is unchanged; only where the POSIX worktree
physically lives moved.

Capabilities differ per strategy and are **reported, never assumed** — sealant's `supports()`
already refuses what a runtime cannot do (the Docker service where the operator has not enabled it,
gVisor selection, mount sources on Cloudflare), the API refuses at create with a stable code
(`runtime-env-references-unsupported`, `workspace-docker-unsupported`) so nothing is queued, and
Mend's `worktreeMount` answers `undefined` where co-location does not hold. UI copy follows the
voice rules: state the observed capability gap, never a judgment.

## The two Mend-side ports

- **`SessionRepository`** (`packages/sessions/src/session-repository.ts`): the identity-keyed
  authority. `createWorktree` / `resetWorktree` / `removeWorktreeForce` / `checkpoint`, keyed by
  project + session + worktree name. `SessionRepositoryLocalLive` serves both co-located strategies;
  a hosted adapter implements the same operations by running git where the authority actually lives.
  `worktreeMount` is the explicit co-location capability.
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

**Capture store (ADR-0002, in progress).** `MEND_SESSION_STORE=captured` replaces the co-located
invariant above for remote executors: object storage plus Postgres pointers hold the authority, the
executor works on its own disk, and Mend reads the chain head through a runner. The dev stack
(`compose.dev.yaml`) runs Garage for it; the shipped bundle (`compose.yaml` →
`deploy/docker/compose.v2.yaml`) does not carry a bucket yet — adding Garage beside `mend-store`
there, and the helm chart's Rook/Garage choice, are the follow-ups once the local proof holds.

**Correctness pre-work (done, sealant #197):** at-least-once delivery with more than one consumer
required the build-job claim to be race-free and run-exec to be at-most-once. Those hold now
regardless of strategy.

## Open design questions (decide before Tier 1 ships)

1. **Where does the git authority live on Cloudflare?** Sandbox disk is disposable; something
   durable must hold the bare repo + `refs/mend/checkpoints/*` between sandbox generations.
   Candidates: a small git service on a container-backed volume; R2-backed bundles pushed over the
   existing authenticated git transport; Cloudflare's git-native storage once it is
   production-ready. This is the real design work of the hosted `SessionRepository` adapter.
2. **Tenancy lives in Mend, not Sealant.** Hosted Mend needs organizations, `tenant_id` ownership,
   per-tenant secrets, quotas and audit. Sealant stays the single-tenant runtime a deployment owns —
   consistent with its "self-hosted, not SaaS" positioning; hosted Mend deploys a Sealant per cell
   (or per tenant) rather than teaching Sealant multi-tenancy.
3. **Capability surfacing.** The SDK should expose what a workspace's runtime family can and cannot
   do so Mend can degrade UI honestly (no raw TCP forwards, disk ceilings, Docker off). Recorded as
   platform feedback; the typed create-time refusals are the first half of it.
