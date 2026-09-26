# M0 Inventory — queue era → agent workbench

> Historical record (2026-09-26): the 2026-07-25 M0 snapshot of the queue-era codebase. The code and
> `MEND-AGENT-WORKBENCH-PLAN.md` superseded it; do not read it as current architecture.

The M0 direction-reset inventory required by `MEND-AGENT-WORKBENCH-PLAN.md` §12/§19. Every
significant module classified as **REUSE** (unchanged), **REFRAME** (works, wears queue-era names),
**EXTRACT** (useful logic buried in a retiring surface — pull it out first), or **RETIRE later**
(queue-specific; per plan §10, extract before deleting). Surveyed 2026-07-25 at the direction reset;
~11k LOC across `apps/web/src` and all packages.

## Headline findings

1. **The durable-session engine already exists.** `packages/jobs/src/run-starter.ts` holds the
   supervisor loop (record stream → `saveLastSeenSequence` → notify → settle), crash-resume from
   `lastSeenSequence`, and `ensureCommitted` git snapshots — M1's session supervision and
   proto-checkpointing, welded to issue-era entry points. Highest-value extraction in the repo.
2. **⚠️ Table-name collision.** better-auth already owns `CREATE TABLE "session"` (migration
   `0001_init`). The new product Session must use another table name — use `agent_sessions` in
   migration `0004`.
3. **The diff renderer is net-new.** No component renders a diff anywhere. The tokens are waiting
   (`--sw-add-edge/-bg`, `--sw-del-edge/-bg` in `packages/ui`, currently unconsumed); the only
   diff-producing code is `SealantClient.diffCommits` and `diffCounts` in
   `packages/inference/src/live-tools.ts`.
4. **The brief compiler's SYSTEM prompt is the product voice** (evidence-not-verdicts, earned
   dispositions, gaps-are-content) and transfers to the change overview and "Mend reads the change"
   (M2.5) nearly wholesale.
5. **`RunStarter`/`RunStartError` are declared inside `dispatcher.ts`** — move them out before the
   dispatcher retires.

## Classification

### packages/domain

| Path                 | What                                          | Class        | Notes                                                                                                                                                                                  |
| -------------------- | --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence.ts`        | `EvidencePointer` (runId, sequence, excerpt)  | REUSE        | Exactly §9.1's stable-pointer rule.                                                                                                                                                    |
| `ids.ts`             | Branded ids                                   | REFRAME      | Keep `RunId`/`SealantRunId`/`SealantWorkspaceId`/`Sha`/`ChangeId`; `IssueId`/`BriefId`/`ReviewQuestionId`/`BriefCommentId` → `ProjectId`/`SessionId`/`CheckpointId`/`ReviewCommentId`. |
| `run.ts`             | `Run`, `RunStatus`, `RunKind`, `FailureBrief` | REFRAME      | This _is_ Session (§5.5). Drop required `issueId` + `RunKind`; add `waiting`/`idle` statuses.                                                                                          |
| `change.ts`          | `Change`, `Freshness`                         | REFRAME      | Keep branch/baseSha/headSha/freshness; drop `issueId`, `prNumber`/`prUrl`; add comparison shape + checkpoint refs.                                                                     |
| `brief.ts`           | `BriefDocument` + parts                       | REFRAME      | → change overview (§10). Only `header.prRef`/`issueRef` are issue/PR-bound.                                                                                                            |
| `review-question.ts` | `Disposition`, `ReviewQuestion`               | REFRAME      | Disposition taxonomy is the honest core; → review checklist / attention items.                                                                                                         |
| `brief-comment.ts`   | `BriefComment`, `RoutedAction`                | REFRAME      | → `ReviewComment` (§5.7); `thread: q<index>` → file/line/hunk anchor.                                                                                                                  |
| `inference.ts`       | `InferenceContext`, tool-name unions          | REFRAME      | Audit row reusable; both literal unions are queue vocab.                                                                                                                               |
| `issue.ts`           | `Issue`, `IssueStage`, `IssueSource`          | RETIRE later | Nothing to extract.                                                                                                                                                                    |
| `settings.ts`        | `PrMode`, `concurrency`                       | RETIRE later | Settings _shape_ (one jsonb row) lives in the repo layer and stays.                                                                                                                    |
| `index.ts`           | Barrel + cardinality docblock                 | REFRAME      | Docblock asserts `issue 1──0..n runs` — the exact contradiction M0 removes.                                                                                                            |

### packages/db

| Path                       | What                                  | Class        | Notes                                                                                                   |
| -------------------------- | ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `client.ts`, `migrator.ts` | Pg layer, boot migrator               | REUSE        | Product-agnostic.                                                                                       |
| `migrations.ts`            | 3 migrations incl. better-auth tables | REFRAME      | Additive `0004_…` for project/agent_sessions/change/checkpoint/review_comment. ⚠️ `session` name taken. |
| `events.ts`                | `mend_events` NOTIFY + pointer events | REFRAME      | Pointer-event discipline is right; every variant currently carries `issueId`.                           |
| `repos/runs.ts`            | `RunsRepo`                            | REFRAME      | → `SessionsRepo`; `listUnsettled`/`saveLastSeenSequence`/`settle` are the M1 reattach primitives.       |
| `repos/briefs.ts`          | Versioned whole-document publish      | REFRAME      | Storage model fits overview history; `issueIdOf` join goes.                                             |
| `repos/brief-comments.ts`  | Comments repo                         | REFRAME      | → `ReviewCommentsRepo`; notify re-anchors to session/change.                                            |
| `repos/changes.ts`         | `ChangesRepo`                         | REFRAME      | `ensureForIssue` → `ensureForSession`; COALESCE head-refresh upsert reusable.                           |
| `repos/inference-calls.ts` | Inference audit writer                | REUSE        | Opaque strings at this layer.                                                                           |
| `repos/settings.ts`        | One-jsonb-row settings                | REUSE        | Payload type changes only.                                                                              |
| `repos/issues.ts`          | Queue-position machine                | RETIRE later | `QueueMove`/`placeInQueue`/`topOfQueued`/`markMending`… Note: API contract imports its types (below).   |
| `errors.ts`                | `IssueNotFoundError`                  | RETIRE later |                                                                                                         |

### packages/api

| Path                                           | What                               | Class        | Notes                                                                                          |
| ---------------------------------------------- | ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `events.ts`                                    | SSE route (auth, listen, 25s ping) | REUSE        | §9.4-blessed transport, proxy-friendly already.                                                |
| `contract.ts` auth/health/sealant groups       | Auth seam + checks                 | REUSE        |                                                                                                |
| `contract.ts` run-audit views                  | `RunDetail`, trace/source DTOs     | REFRAME      | → session views; rename only.                                                                  |
| `contract.ts` briefsGroup                      | Brief + comments endpoints         | REFRAME      | Content survives; all four routes are nested under `/issues/:id` and re-key to session/change. |
| `contract.ts` issuesGroup                      | list/create/detail/**move**        | RETIRE later | `POST /issues/:id/move` is the drag-and-drop wire contract.                                    |
| `server.ts` `RunsGroupLive`                    | Record-open → paginate → aggregate | EXTRACT      | The session-detail engine, welded to `RunId`; includes graceful record-gap degradation.        |
| `server.ts` `BriefsGroupLive` + `briefOfIssue` | issue→change→brief spine           | REFRAME      | Spine becomes session→change→overview.                                                         |
| `server.ts` `IssuesGroupLive`                  |                                    | RETIRE later |                                                                                                |

### packages/auth · sealant · jobs · inference · ui

| Path                                                              | What                                                        | Class        | Notes                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `auth/*`                                                          | better-auth Effect service, cookie+bearer                   | REUSE        | Bearer already covers M4 mobile; add tailnet host to `trustedOrigins` later.                                |
| `sealant/client.ts`                                               | Full SDK facade incl. `diffCommits`, `exec`, `recordStream` | REUSE        | Additive work only (mounts, PTY) per §8. `diffCommits` is the local-diff engine today.                      |
| `sealant/{config,connection,errors}.ts`                           | Env + observed-status model                                 | REUSE        |                                                                                                             |
| `jobs/job-runner.ts`                                              | `JobRunner` seam + pg-boss + test layer                     | REUSE        | Engine-agnostic; stale idempotency-key docblock.                                                            |
| `jobs/run-starter.ts`                                             | Supervisor, resume, git facts, prompts                      | **EXTRACT**  | Supervisor + `resume()` + `ensureCommitted` → M1 session engine; issue-era prompts/`start(issue)` retire.   |
| `jobs/dispatcher.ts`                                              | Queue poll loop **+ `RunStarter` declaration**              | RETIRE later | Extract `RunStarter`/`RunStartError` out first.                                                             |
| `jobs/start-run-tool.ts`                                          | `start_run` tool binding                                    | RETIRE later | Shape survives as send-review-to-session.                                                                   |
| `inference/provider.ts`, `sealant-provider.ts`, `dev-provider.ts` | The §9.3 seam, shipped + dev layers                         | REUSE        | Already implements "no hosted model".                                                                       |
| `inference/live-tools.ts`                                         | read_recording / read_change layers, `diffCounts`           | EXTRACT      | Recording reader reusable as-is; `readChange`+`diffCounts` seed the diff foundation; `readIssue` retires.   |
| `inference/toolset.ts`                                            | Tool adapter + per-context assembly + length caps           | EXTRACT      | Generic machinery keeps; the specific tool sets are queue-era.                                              |
| `inference/tools.ts`                                              | Tool service contracts                                      | REFRAME      | Recording contracts REUSE; `PublishBrief`→publish overview; `StartRun`→send-to-session; issue tools retire. |
| `inference/brief-compiler.ts`                                     | Compiler + SYSTEM prompt                                    | REFRAME      | → change-overview compiler + "Mend reads the change" (M2.5). Prompt is the product voice.                   |
| `inference/comment-router.ts`                                     | Exactly-once comment routing                                | REFRAME      | → follow-up assembly (§9.3); reply-or-run discipline survives.                                              |
| `inference/failure-summarizer.ts`                                 | Schema-constrained failure brief                            | REFRAME      | → session-failure summary.                                                                                  |
| `ui/styles/globals.css`                                           | Evidence Review tokens incl. **unused diff tints**          | REUSE        | Pre-built for the new review surface.                                                                       |

### apps/web

| Path                                                                                                                                                             | What                                      | Class        | Notes                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry/main.ts`                                                                                                                                                  | Composition root, `MEND_MODE` split       | REFRAME      | Boundary shape right; worker set (`brief`/`failure-brief`/`route-comment` + dispatcher fork) is queue-era.                                                                                |
| `lib/auth-client.ts`, `router.tsx`, `styles.css`, `components/logo.tsx`, `components/status.tsx`, `routes/login.tsx`, `routes/settings.tsx`, `routes/__root.tsx` | Shell plumbing                            | REUSE        | `__root.tsx` has one stale `DESCRIPTION` string; `StatusDot` grows `waiting`/`idle`.                                                                                                      |
| `components/shell.tsx`                                                                                                                                           | `AppShell` nav                            | REFRAME      | Queue/Settings → Now/Projects/Context/Settings.                                                                                                                                           |
| `lib/api.ts`                                                                                                                                                     | Wire DTOs + fetch helpers                 | REFRAME      | Helpers + "404 is a state" pattern keep; nearly every DTO is issue/brief-keyed.                                                                                                           |
| `routes/runs.$runId.tsx`                                                                                                                                         | **Run audit page**                        | REFRAME      | → session detail (§10); add live PTY pane; historical rendering keeps working.                                                                                                            |
| `components/brief.tsx`                                                                                                                                           | **The brief** (418 LOC)                   | REFRAME      | → change overview. `EvidenceList`/`EvidenceLink` (claim → `(run, seq)` click-through) is the crown jewel.                                                                                 |
| `components/review-conversation.tsx`                                                                                                                             | Comment threads + routed-decision display | REFRAME      | Anchoring `q<index>` → file/line/hunk.                                                                                                                                                    |
| `components/failure-brief.tsx`                                                                                                                                   | Failure card                              | REFRAME      | Imports from `brief.tsx` — preserve the coupling.                                                                                                                                         |
| `routes/issues.$issueId.tsx`                                                                                                                                     | Issue detail composition                  | EXTRACT      | Page retires; `VersionedBrief` (version history + superseded notice) and the brief+comments+runs composition shape are the new session/review pages.                                      |
| `routes/index.tsx`                                                                                                                                               | **The queue board** (346 LOC, @dnd-kit)   | RETIRE later | Extract first: SSE-subscription + per-entity progress state (→ Now feed), `NewIssueForm` pattern (→ adopt project), live-card treatment (→ session card). Drop 3 `@dnd-kit` deps with it. |

`apps/marketing`: `components/{brief,run-record,source-trail,primitives}.tsx` stay as
design-language reference; `sections/queue.tsx` + `sections/mobile.tsx` state the retired thesis
(site refresh pending); `sections/evidence.tsx`/`sources.tsx` transfer.

## Queue vocabulary & issue/PR assumptions (what migration `0004` + contract rework must displace)

- **Tables:** `issues` (`stage` default `'triage'`, `position`, `issues_stage_position_idx`);
  `changes.issue_id NOT NULL UNIQUE` (the one-issue-one-change rule as a constraint) + `pr_number`/
  `pr_url`; `runs.issue_id NOT NULL … ON DELETE CASCADE` + `kind`; `briefs.change_id UNIQUE`;
  `brief_comments.thread` (`general`/`q<index>`); `settings` jsonb (`prMode`, `concurrency`).
- **Events:** every `MendEvent` variant carries `issueId`; brief/comment repos JOIN back to issues
  for notify payloads.
- **Contracts:** `POST /issues/:id/move` (`QueueMove`); all brief routes under `/issues/:id/…`;
  `contract.ts` imports `NewIssue`/`QueueMove` from `@mend/db` (API payloads are queue repo types).
- **Web DTOs:** `IssueStage` union, `moveIssue`, issue-keyed everything in `lib/api.ts`.
- **Inference wire:** `ReadIssue`/`PostIssueComment`, `StartRunInput.kind`, job payloads all carry
  `issueId`; `JobSpec` docblock names `open-pr:`/`merge:` keys.

## Retire-order constraints

1. Extract `RunStarter`/`RunStartError` out of `dispatcher.ts` before retiring the dispatcher.
2. Extract the supervisor/`resume()`/`ensureCommitted` from `run-starter.ts` before touching its
   issue-era entry points (`start(issue)`, auto-`startVerification`, prompts).
3. Extract the SSE-invalidate + progress-line state from `routes/index.tsx` before the board goes
   (it becomes Now's live feed); then drop `@dnd-kit/*`.
4. `packages/api` depends on `@mend/jobs` only for the `route-comment` enqueue — keep the seam, the
   job becomes the follow-up assembly.
5. Keep `pg-boss` (the `JobRunner` seam is engine-agnostic); the _dispatcher_ retires, not the job
   runner.

## Net-new (no code to reuse)

- Diff/hunk renderer (tokens ready, zero components).
- Central store service (bare repo + worktrees + checkpoint refs).
- `mend` CLI wrapper (adopt / launch / attach).
- Context items/packs/snapshots/handoffs (M3) and machine pairing (M4).
