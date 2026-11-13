> **SUPERSEDED · 2026-07-25** — This document describes the retired issue-to-PR / queue direction.
> The canonical direction is [`MEND-AGENT-WORKBENCH-PLAN.md`](../../MEND-AGENT-WORKBENCH-PLAN.md) at
> the repo root; where they conflict, the plan wins. Kept as design history — do not implement
> against this. Reusable pieces are mapped in the plan §10.

# Mend — Roadmap

Derived from `PRODUCT.md` (what) and `ARCHITECTURE.md` (how); expands `MEND-PLAN.md` §12. Each
milestone has an exit test phrased as something you can actually do. Order is deliberate: every
milestone ends with the product more usable than before, and the platform-feedback workstream runs
in parallel because Mend exists to dogfood Sealant and the SDK.

## M0 — Foundations

Scaffold the product skeleton so everything after is feature work.

- `packages/domain` (Effect Schema models) · `packages/db` (Postgres via Effect SQL, migrations) ·
  `packages/api` (HttpApi contract + server) · `packages/auth` (better-auth) · `packages/jobs`
  (JobRunner seam + pg-boss layer, dispatcher skeleton) · `packages/sealant` (SDK wrapped in
  Effect).
- The Docker image (`MEND_MODE=all`) + compose file (mend + postgres + Sealant env), CI for
  typecheck/lint/build.
- `apps/web` shell: login, empty queue, settings page with Sealant connection check.

**Exit:** `docker compose up` on a clean machine → log into your own Mend → it talks to your
Sealant.

## M1 — The queue, against manual issues

The loop's spine, with manual intake (per plan: queue before integrations).

- Manual issue entry (title/body/repo) into **triage**; queue board with first-class drag
  (@dnd-kit): `triage → queued → mending → review → merged`.
- Dispatcher with `mend.concurrency` setting; Gate 1 is the drag, nothing else starts work.
- Run supervisor: `harness.start()` → live card from `record.stream({from})`, crash-resume from the
  stored sequence; failed runs return the card to triage carrying the failure.
- `runs` indexed in Postgres with evidence pointers; run detail page shows commands/transcript from
  the SDK read surface.

**Exit:** drag a manual issue into the queue → watch it mend live → the run settles
(completed/failed) with its record browsable.

## M2 — The brief and the run audit

The product noun. Needs the inference seam; buildable before the SDK inference API ships (dev
layer), shippable when it does.

- `packages/inference`: `InferenceProvider` contract, the eight tools from PRODUCT.md, the
  `inference_calls` audit trail.
- Brief compilation grounded in the record: header facts, what-was-done, review questions with
  earned dispositions, quoted excerpts denormalized, `publish_brief` versioning.
- Causal proof via verification runs (`workspace.exec` shipped in 0.5.0; the harness-prompted
  interim stands until a structured reproduction command exists to make the legs deterministic).
- The run audit v1: milestones + full trace + sources + loss report (the typed source-event taxonomy
  shipped in 0.5.0, so the sources tab landed with v1).
- Failure mini-brief rendered in-app (tracker comment lands in M3).

**Exit:** a mended manual issue produces a brief whose every green claim clicks through to the
recorded evidence behind it.

## M3 — GitHub

The loop reaches the real world; this is the self-host alpha.

- GitHub connection in settings (App preferred, PAT accepted); issue intake from GitHub.
- Draft-PR-immediately default: PR opens on run success, brief posted into the description with deep
  links; CI check results polled into the brief as corroborating evidence.
- Gate 2: approve in Mend → merge (arms auto-merge when checks pending); the alternate
  no-PR-until-approval mode.
- Failure comments posted on the GitHub issue.
- Freshness: poll base; flip `evidence stale · <old> → <new>`; one-click re-verify in a fresh
  workspace.

**Exit:** Flow 1 (the happy path) end-to-end on a real repository, including merge from Mend.

## M4 — Iteration

Review becomes a conversation.

- Reviewer comments on the brief; comment routing through the inference loop (follow-up run ·
  question back · verification pass).
- Follow-up runs on the same branch/PR; the brief recompiles across all recordings behind head;
  versions visible.

**Exit:** Flow 3 — comment on a brief, get a follow-up run, watch the brief recompile.

## M5 — Intake integrations

- Linear, then Jira, as `packages/trackers` layers (the contract already exists from GitHub +
  manual).
- Optional admin-configured inbound webhooks as the fast path over polling (low priority,
  settings-driven).

**Exit:** a Linear issue runs the whole loop untouched by hand.

## M6 — Mobile

- Expo app: login by server URL + token; queue (drag included), live mending cards, the full brief,
  approve & merge.
- Transport decision (SSE polyfill vs WebSockets) made here; push notifications stay deferred.

**Exit:** Flow 6 — the full loop, phone only.

## Parallel — platform workstream (dogfooding)

Items live in `PLATFORM-FEEDBACK.md`; building them in sealant/SDK is in scope for this project.
Priority order:

1. **Inference on connected accounts** — unblocks M2's shipped configuration.
2. **`@sealant/sdk/effect` subpath** — deletes the Promise-wrapping in `packages/sealant`.
3. **Deterministic `workspace.exec`** — makes the causal proof mechanical (M2/M3 quality).
4. **Record source-event taxonomy** — unlocks the run audit's sources tab (post-M2).
5. **SSE / control-plane webhooks · workspace close-out** — efficiency, not blockers.

## Parallel — docs

`apps/docs` (Fumadocs, TanStack Start adapter) lands with M3: self-host guide, GitHub setup, the
product-language pages sourced from `PRODUCT.md`.
