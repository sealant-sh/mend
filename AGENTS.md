# Mend Quick Context

Mend (by Sealant) is a `pnpm` + `turbo` monorepo. Mend is a **local-first workbench for developers
who use coding agents heavily**: adopt a repository into Mend's central store, run your own agent
(`mend codex`, `mend claude`, an arbitrary command) in a recorded per-session git worktree, review
the accumulated local change with evidence beside every claim, send review comments back to the same
session, and steer it all from any device over a private network. No issue tracker or PR required.
Read `MEND-AGENT-WORKBENCH-PLAN.md` first; it is the canonical product direction and carries the
decision log. The retired issue-to-PR/queue documents live in `docs/archive/` — do not implement
against them.

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
  and `handoff` (the editable end-of-session summary promoted into durable context). Interface-side
  inference deliberately has **no product noun** — write "Mend uses inference"; the machine review
  pass is phrased "Mend reads the change" (draft comments and proposed checks, never verdicts; every
  finding links to the record or ships a runnable check). Cardinality: sessions are many per
  project, one worktree each; one change per session; landing a change (merge/commit/PR) is
  publication, optional by definition.
- Tenancy nouns (`docs/adr/0003-organizations-and-tenancy.md`): `organization` (the tenant; owns its
  members, projects, folders, reference repositories and audit log; an account belongs to exactly
  one), `owner` and `member` (organization roles), `operator` (an instance role that administers the
  machine and has no default read access to organization content), `invitation` (a single-use link;
  registration is closed after the first account), `folder` (a Mend-managed directory that replaces
  host mounts). A project's visibility is `private` (its creator only) or `shared` (its
  organization). Only a session's owner steers it unless they turn on `shared control`, which lets
  others steer while spending the owner's credentials. `MEND_TENANCY=single|multi` picks the
  posture; `single` is the default and `multi` stays refused until the multi mode gate passes.
- Access nouns (`docs/adr/0004-access-without-a-private-network.md`): `exposure` is how an instance
  is reached, as its operator declares it: `loopback`, `private` (a network they control admission
  to) or `public`. Mend reports what it **observed** beside what was **declared**; an item neither
  covers is `open`. The `public exposure gate` is that report. An `edge` terminates TLS in front of
  the web tier. An `upgrade ticket` is the single-use, thirty-second credential a socket or the
  terminal embed carries in its URL. A `budget` bounds what a client, an account or an organization
  may ask; it refuses new work and never stops running work. Never write "tailnet · reachable",
  "safe to expose" or "gate passed": write what was declared and what was observed.
- Slack nouns (`docs/adr/0006-slack.md`): a `Slack app` is an organization's own install, made from
  Mend's manifest and connected over Socket Mode (outbound only). A `Slack link` joins one Slack
  user to one Mend account, explicitly, never by email. A `Slack thread` is a thread sessions report
  to; `@mend <prompt>` there is a follow-up. Mend picks a session's project from the message, then
  the thread, then the channel default, then the person's default, and says which one decided.
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
- A `--base` is not a stack. `gh pr create --base <branch-below>` only sets one PR's merge target;
  the PRs are still unrelated on GitHub. Dependent PRs need the stack registered as well — run
  `gh stack link <bottom> <top> …` when the branches or PRs already exist (numbers work:
  `gh stack link 82 83`), or `gh stack init`/`gh stack add` + `gh stack submit --auto --open` for
  new work. Only then do they show as one stack, retarget themselves as each lands, and merge with
  `gh stack merge --yes`. Never hand-rebase a branch and `gh pr edit --base` instead.
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
