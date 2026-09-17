# Mend Quick Context

Mend (by Sealant) is a `pnpm` + `turbo` monorepo. **Code is now cheap. Trust is not.** Mend is a
**local-first workbench for developers who use coding agents heavily**: adopt a repository into
Mend's central store, run your own agent (`mend codex`, `mend claude`, an arbitrary command) in a
recorded per-session git worktree, review the accumulated local change with evidence beside every
claim, send review comments back to the same session, and steer it all from any device over a
private network. No issue tracker or PR required. Read `MEND-AGENT-WORKBENCH-PLAN.md` first; it is
the canonical product direction and carries the decision log. The retired issue-to-PR/queue
documents live in `docs/archive/` — do not implement against them.

- `apps/marketing`: TanStack Start marketing site (Cloudflare Workers via wrangler). Pitches the
  workbench direction (refreshed 2026-08-01).
- `apps/web`: TanStack Start product web app — Now · projects · sessions · review.
- `packages/*`: shared libraries (`ui` design tokens, domain packages as they appear).
- `tooling/*`: shared configs (`typescript`).

Mend consumes the Sealant platform **only through the public SDK** (`@sealant/sdk` on npm):
`workspaces.create({ repository, harness })`, blocking `harness.run(prompt)` or non-blocking
`harness.start(prompt)` + `run.record.stream()`, `run.wait()`, `run.changes`, and the replayable
record. **Never import Sealant internals.** If the SDK is missing something Mend needs, record it as
platform feedback (in `PLATFORM-FEEDBACK.md`) instead of working around it.

## Product Language Contract

- The primary product nouns are `project` (a repository adopted into the machine's central store),
  `session` (one supervised coding-agent process in its own git worktree; bring-your-own harness),
  `change` (the reviewable object: session worktree versus its base), `checkpoint` (a hidden git ref
  stamped with the record sequence; any two checkpoints define a reviewable slice), `context pack` /
  `context snapshot` (explicit, versioned selection; every session receives an immutable snapshot),
  `handoff` (the editable end-of-session summary promoted into durable context), and `team` (a named
  group of accounts on one instance; a project's `scope` is personal, one team, or the whole
  instance, and scope is what every access check reads —
  `docs/adr/0002-teams-and-project-scope.md`). Interface-side inference deliberately has **no
  product noun** — write "Mend uses inference"; the machine review pass is phrased "Mend reads the
  change" (draft comments and proposed checks, never verdicts; every finding links to the record or
  ships a runnable check). Cardinality: sessions are many per project, one worktree each; one change
  per session; landing a change (merge/commit/PR) is publication, optional by definition.
- The queue is gone: no triage/queued/mending stages, no issue intake, no kanban. Issues and PRs are
  optional references attached to work, never its identity.
- Platform nouns follow Sealant: `workspace` (the live environment; sessions run in workspaces that
  mount their worktree), `run` (a session is backed by a run and its durable record), `harness`.
- Evidence, not verdicts: status words describe what was observed ("Completed · observed"), never a
  judgment ("safe to merge"). Mend reports; the human decides.
- Full vocabulary and voice rules: `MEND-AGENT-WORKBENCH-PLAN.md` §5 (product model) and §16 (UX
  rules); design language in `DESIGN.md`.

## Agent Defaults

- Submit pull requests as ready for review, never as drafts. With `gh stack`, use
  `gh stack submit --auto --open`.
- Never open a PR (or push a branch for one) without first running
  `pnpm exec turbo typecheck --force` and `pnpm exec turbo lint --force` and seeing both pass —
  forced, so a warm cache can't lie.
- `pnpm-lock.yaml` is generated, never hand-edited: let `pnpm install` / `pnpm add` write it, and
  commit the result alongside the `package.json` change that caused it — a PR that adds a dependency
  ships its lockfile update.
- After code changes, always run `pnpm format:fix`.
- For type-checking, always use `tsgo` (`pnpm typecheck`) and do not use `tsc`.
- For internal dependencies, always use `workspace:*` in `package.json` and import via
  `@mend/<package-name>`; never import from `../packages/*` paths.
- For external dependencies used by more than one app/package, prefer `catalog:` versions in
  `package.json` instead of inline semver.
- If a shared external dependency is missing from the catalog, add it to the root
  `pnpm-workspace.yaml` `catalog` and then reference it as `catalog:` from importers.
- Do not duplicate shared external dependency version strings across apps/packages; keep version
  authority in `pnpm-workspace.yaml`.
- For any non-tiny UI change, read `DESIGN.md` first and follow it as the design source of truth.
  Mend must be visually identical family with Sealant's Evidence Review language.
- Do not add `"use client"` anywhere; this repo is not Next.js.
- In React code, avoid `useEffect` unless there is no cleaner data-flow option.
- Avoid `any` and avoid type assertions/casts like `as X` unless absolutely unavoidable.

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay (OpenAI has really generous limits),
not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers
UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
| -------- | ---- | ------------ | ----- |
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper
  model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking.
  Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste >
  cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 — it's
  effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent
  perspective.
- Never use Haiku.
- Mechanics: gpt-5.5 is only reachable through the Codex CLI — `codex exec` / `codex review` (my
  ~/.codex/config.toml defaults to gpt-5.5). Use the codex-implementation, codex-review, and
  codex-computer-use skills; for work they don't cover (investigation, data analysis), run
  `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents (the model parameter only takes Claude models, so use a
wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it
  to write a self-contained codex prompt, run `codex exec` via Bash, and return the codex output
  verbatim.

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `pnpm exec effect-solutions list` to see available guides
2. Run `pnpm exec effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations
4. Define Effect services as types/contracts first (`Context.Tag` / `ServiceMap.Service`) with no
   embedded live implementation in the definition.
5. Define live/test implementations as separate layer constants after the service definitions (same
   file is fine when clearly sectioned), and compose those layers at the boundary. This is a safety
   rule, not style: a `static layer` embedded in the class body can silently infer `Layer<never>`
   (self-reference during declaration) and then provides nothing — the leak only errors at the far
   boundary. Give the separate constant an explicit type: `const XLive: Layer.Layer<X> = …`. Do not
   copy the embedded statics that still exist in the repo (e.g. `StoreConfig.layer`); they infer
   correctly today by luck, not by design.

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling,
error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference. Use
this to explore APIs, find usage examples, and understand implementation details when the
documentation isn't enough.
