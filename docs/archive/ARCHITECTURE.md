> **SUPERSEDED · 2026-07-25** — This document describes the retired issue-to-PR / queue direction.
> The canonical direction is [`MEND-AGENT-WORKBENCH-PLAN.md`](../../MEND-AGENT-WORKBENCH-PLAN.md) at
> the repo root; where they conflict, the plan wins. Kept as design history — do not implement
> against this. Reusable pieces are mapped in the plan §10.

# Mend — Architecture

How the product in `PRODUCT.md` gets built. Constraints inherited from the plan: self-hosted only ·
platform access through `@sealant/sdk` only (gaps → `PLATFORM-FEEDBACK.md`) · no model keys shipped
(inference on the user's Sealant-connected subscriptions) · every claim traceable to recorded
evidence.

## 1. Deployables

**The product is one Docker image plus Postgres.** The image runs the web app (TanStack Start SSR),
the Effect API, the dispatcher, and the workers in a single Node process; a `MEND_MODE` env exists
from day one (`all` default · `web` · `worker`) so the process can be split later without a
redesign. The compose file ships `mend` + `postgres` and points at the operator's existing Sealant
control plane (`SEALANT_BASE_URL`, `SEALANT_API_KEY`).

Not part of the product image:

- **`apps/marketing`** — Cloudflare Workers, published from this repo.
- **`apps/docs`** — Fumadocs via its TanStack Start adapter, published from this repo.
- **`apps/mobile`** — React Native + Expo, published to the stores for free; login is **server URL +
  token** (one binary, any instance). Nothing in the mobile app assumes a hosted service.

## 2. Monorepo layout (target)

| Path                 | What                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `apps/web`           | The product app: queue · brief · run audit (TanStack Start, SSR + client)              |
| `apps/marketing`     | Public site (exists)                                                                   |
| `apps/docs`          | Fumadocs on the TanStack Start adapter                                                 |
| `apps/mobile`        | Expo app — the full loop including merge                                               |
| `packages/ui`        | Evidence Review tokens/components (exists, vendored)                                   |
| `packages/domain`    | Effect Schema models: issue, change, run, brief, review question, disposition, events  |
| `packages/db`        | Postgres access (Effect SQL), migrations, the jobs table                               |
| `packages/api`       | The Effect `HttpApi` contract + server implementation (one package, contract-first)    |
| `packages/auth`      | better-auth wiring: sessions (web) + bearer tokens (mobile)                            |
| `packages/jobs`      | `JobRunner` seam + pg-boss live layer · the dispatcher · run supervisors               |
| `packages/sealant`   | Effect services wrapping `@sealant/sdk` (Promise facade wrapped until `/effect` ships) |
| `packages/trackers`  | The tracker seam: one service contract, `github` first, then `linear`, `jira`          |
| `packages/inference` | `InferenceProvider` seam + the closed tool set from PRODUCT.md                         |

Rules that keep this sane (from `AGENTS.md`): services are defined as contracts
(`Context.Tag`/`ServiceMap`), live/test layers separate, composition at the boundary (`apps/web`
server entry and the worker entry).

## 3. Data ownership

**Postgres owns product state; Sealant owns raw recordings.** Mend references recordings by
`(run_id, sequence)` — never copies the trace. Verified against SDK 0.4.0: records outlive
workspaces by design (`runs.get()` exists exactly for this) and `record.timeline({ from })` /
`stream({ from })` give stable, resumable sequence addressing.

sealant tables (illustrative, not a migration):

- `issues` — tracker identity, source, title/body, stage (`triage → … → merged`), queue `position`.
- `changes` — one per issue: branch, base/head shas, PR ref, freshness (`current · stale`).
- `runs` — index of harness executions: sealant run id, kind (`initial · follow-up · verification`),
  status, outcome; the recording itself stays in Sealant.
- `briefs` + `brief_versions` — the living document; each claim carries evidence pointers
  (`run_id, sequence`) **and the quoted excerpt it displays**, denormalized so briefs render without
  a Sealant round-trip and stay readable forever.
- `review_questions` — question, disposition (`direct evidence · not executed · unrelated change`),
  evidence pointers.
- `inference_calls` — the interface-inference audit trail: context, tool, input, output, timestamp.
- `jobs` — pg-boss's schema.
- `settings`, better-auth tables, encrypted integration secrets.

## 4. The API

One Effect `HttpApi` served from the product process; consumed by the web app (SSR loaders and
client) and the mobile app. Contract-first in `packages/api` so mobile/web share generated types
with validation at the boundary (Effect Schema).

- **Auth:** better-auth mounted on the same server. Cookie sessions for web; bearer tokens for
  mobile and CLI-ish use.
- **Live updates:** SSE endpoints (queue changes, run card streams, brief recompiles). SSE chosen
  for v1 (plain HTTP, proxy-friendly); the mobile transport gets revisited when `apps/mobile` starts
  — RN needs an EventSource polyfill, and if that's ugly we switch that surface to WebSockets then.

## 5. Async work

Three distinct mechanisms — deliberately not one queue library doing all three:

1. **The dispatcher.** The user-visible queue is domain state (`issues.position`), never a job
   queue. A single loop (LISTEN/NOTIFY-woken, poll fallback) fills free mending slots from the top
   of `queued`. Concurrency is a product setting (`mend.concurrency`, default 1). Reordering is just
   a row update.
2. **Run supervisors.** One supervised fiber per active run: consumes `record.stream({ from })`,
   projects card status, persists the last-seen sequence. Crash/restart → re-attach from that
   sequence (SDK supports this today). Run starts are idempotent via the SDK's `idempotencyKey` (set
   to the `runs.id`).
3. **Side-effect jobs.** Open PR, post comment, publish brief, merge on approval, compile brief.
   Executed by pg-boss **behind a `JobRunner` service contract** (enqueue with idempotency key,
   retry policy, dead-letter → visible failure state). Idempotency keys are structural:
   `open-pr:{change_id}`, `merge:{change_id}`, `brief:{change_id}:{head_sha}`. If pg-boss ever
   disappoints, the seam means the engine is a layer swap (e.g. `@effect/cluster` workflows once
   they're proven under v4).

Kept light on purpose: no Redis, no workflow engine, nothing beyond Postgres.

## 6. Inference

Per `PRODUCT.md` ("Inference in the interface"): no product noun, closed first-party tool set,
enforced by omission.

- `packages/inference` defines the **`InferenceProvider` contract** (structured output +
  tool-calling loop) and the tool services (`read_recording`, `read_issue`, `read_change`,
  `read_brief`, `post_issue_comment`, `reply_on_brief`, `start_run`, `publish_brief`). Every call is
  written to `inference_calls`.
- **Shipped live layer: Sealant, on the user's connected subscriptions.** That surface does not
  exist in SDK 0.4.0 — recorded in `PLATFORM-FEEDBACK.md` (inference on connected accounts). Until
  it ships, a dev-only layer may call a provider directly behind the same contract; it is never the
  shipped default.

## 7. Sealant integration

`packages/sealant` wraps the SDK in Effect services (the `/effect` subpath isn't exported in 0.4.0 —
feedback filed). Findings from the 0.4.0 audit that shape the design:

- **Runs:** `harness.start()` + `record.stream({ from })`, resumable — supervisors re-attach, never
  re-run. `idempotencyKey` on run start.
- **Records:** outlive workspaces; addressed by sequence. Evidence pointers are
  `(run_id, sequence)`; `commands()`/`transcript()`/`scrollback()` back the run audit; `loss()` is
  surfaced in the audit UI (a provenance-honest gap report is itself evidence).
- **Credentials:** connected-account references only
  (`credentials: { claude, codex, github, profile }`) — exactly matches "Mend ships no model keys".
  The harness pushes the change branch from inside the workspace using the GitHub connected account,
  so the push itself is recorded.
- **Causal proof:** should be deterministic exec; SDK has no `workspace.exec` yet (feedback filed).
  Interim: a verification harness run prompted with the exact commands — still observed, recorded
  evidence, just noisier and pricier than it needs to be.
- **Workspace close-out:** `stop()`/`expire()` are Phase-3 stubs (feedback noted) — until then
  instances rely on Sealant-side lifecycle.

## 8. Trackers & GitHub

- `packages/trackers` defines one intake contract (issues in, comments out) with per-tracker layers:
  GitHub → Linear → Jira, in that order. Manual entry is just another intake layer.
- **PR operations** (open draft, description = the brief, merge, arm auto-merge) go through the
  operator's GitHub credentials configured in settings (GitHub App preferred, PAT accepted for small
  installs), stored encrypted in Postgres.
- **Polling is the baseline** for everything inbound — new issues, CI check results, base-moved
  (freshness) — because self-hosted instances are usually NAT'd. Admin-configured inbound webhooks
  are an optional fast path (settings page), low priority.

## 9. Security

- Single-tenant per instance; better-auth users within it.
- Secrets at rest (tracker tokens, GitHub App key, Sealant API key) encrypted in Postgres.
- Only account references cross the SDK surface (Sealant resolves them server-side).
- Nothing phones home: no telemetry, no hosted dependency, marketing/docs are the only public
  surfaces and they ship separately.

## Open items

- SDK inference API — the one dependency that shapes the brief milestone; tracked in
  `PLATFORM-FEEDBACK.md`, buildable behind the seam meanwhile.
- Source-trail event taxonomy — run audit ships without the sources tab until the record exposes
  source events (feedback filed).
- Mobile transport (SSE polyfill vs WebSockets) — decided when `apps/mobile` starts.
- Mobile push notifications — deferred entirely.
