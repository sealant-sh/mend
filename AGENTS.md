# Mend Quick Context

Mend (by Sealant) is a `pnpm` + `turbo` monorepo. Mend is a **local-first workbench for developers
who use coding agents heavily**: adopt a repository into Mend's central store, run your own agent
(`mend codex`, `mend claude`, an arbitrary command) in a recorded git worktree, review the
accumulated local change with evidence beside every claim, send review comments back to the same
session, and steer it all from any device, over loopback, a private network, or publicly behind an
edge (ADR 0004). No issue tracker or PR required. Read `MEND-AGENT-WORKBENCH-PLAN.md` first; it is
the canonical product direction and carries the decision log. The retired issue-to-PR/queue
documents live in `docs/archive/` — do not implement against them.

- `apps/api`: the Mend server (Effect HttpApi): sessions engine, store, landing, Slack, workers.
- `apps/cli`: the `mend` CLI (`@sealant/mend` on npm): OpenTUI dashboard, sessions, `mend server`.
- `apps/desktop`: Electron desktop app: every live session as a terminal, review beside it.
- `apps/docs`: the docs site (Astro Starlight), published at docs.mend.run.
- `apps/marketing`: TanStack Start marketing site (Cloudflare Workers via wrangler). The landing
  page was replaced on 2026-09-26 (#383): install steps, how it works, integrations, FAQ.
- `apps/mobile`: Expo app: steer sessions and review changes from a phone.
- `apps/vscode`: VS Code extension: open and steer sessions, workspaces over Remote-SSH.
- `apps/web`: TanStack Start product web app — Now · projects · sessions · review.
- `packages/*`: shared libraries: `agent-conversation`, `agent-protocol` (Codex/Claude stdio
  adapters), `api-contracts` (the HTTP API contract), `auth`, `db` (Postgres, migrations), `domain`,
  `inference`, `jobs` (pg-boss), `landing`, `network`, `sealant` (the SDK behind Effect services),
  `sessions` (the session engine), `slack`, `store` (repository store, worktrees, checkpoints), `ui`
  (design tokens), `workspace-ssh`.
- `tooling/*`: shared configs (`typescript`) and build scripts (`scripts`: the server bundler).

Mend consumes the Sealant platform **only through the public SDK** (`@sealant/sdk` on npm):
`workspaces.create({ repository, harness })`, blocking `harness.run(prompt)` or non-blocking
`harness.start(prompt)` + `run.record.stream()`, `run.wait()`, `run.changes`, and the replayable
record. **Never import Sealant internals.** If the SDK is missing something Mend needs, record it as
platform feedback (in `PLATFORM-FEEDBACK.md`) instead of working around it.

## Product Language Contract

- The primary product nouns are `project` (a repository adopted into the machine's central store),
  `session` (one supervised coding-agent conversation in a git worktree; bring-your-own harness),
  `change` (the reviewable object: the worktree versus its base), `checkpoint` (a hidden git ref
  stamped with the record sequence; any two checkpoints define a reviewable slice), `context pack` /
  `context snapshot` (explicit, versioned selection; every session receives an immutable snapshot),
  `session summary` (the editable end-of-session summary promoted into durable context; planned),
  and `handoff` (the act of copying a person's local branch, commits and uncommitted files included,
  into a new session from their checkout; the checkout is never changed; the session row reads
  `handed off from <machine>`). The shipped switch of a session between terminal and conversation is
  a `mode switch`, never a handoff, though its released route keeps the path
  `POST /sessions/:id/handoff`. Interface-side inference deliberately has **no product noun** —
  write "Mend uses inference"; the machine review pass is phrased "Mend reads the change" (draft
  comments and proposed checks, never verdicts; every finding links to the record or ships a
  runnable check). Cardinality: sessions are many per project, each runs in one worktree and a
  worktree can hold several; one change per worktree (every session in the worktree contributes to
  it; its owner is the owner of the worktree's first session); landing a change (merge/commit/PR) is
  publication, optional by definition.
- Tenancy nouns (`docs/adr/0003-organizations-and-tenancy.md`): `organization` (the tenant; owns its
  members, projects, folders, reference repositories and audit log; an account belongs to exactly
  one), `owner` and `member` (organization roles), `operator` (an instance role that administers the
  machine and has no default read access to organization content), `invitation` (a single-use link;
  registration is closed after the first account), `folder` (a Mend-managed directory that replaces
  host mounts). A project's visibility is `private` (its creator only) or `shared` (its
  organization). Only a session's owner steers it unless they turn on `shared control`, which lets
  others steer: in a per-person workspace each turn spends its sender's own login; only a workspace
  that shares one home spends the owner's (ADR 0016 decision 7a). `MEND_TENANCY=single|multi` picks
  the posture; `single` is the default and `multi` stays refused until the multi mode gate passes.
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
- Landing nouns (`docs/adr/0007-landing.md`): `landing` is one push of a session's change to origin,
  plus its pull request, recorded against the `landed checkpoint` whose tree Mend committed. Only
  the change's owner (the owner of the worktree's first session) lands, and Mend never moves the
  session's branch. `automatic landing` lands after a completed turn whose request asked for a
  change (on by default from Slack, as Cursor does), never for a question. Mend never merges, never
  force-pushes, and never writes "ready to merge": a landing reports what was pushed and what GitHub
  last said (`pull request #412 · open · observed`).
- Screen nouns (`docs/adr/0020-guis-in-sessions.md`): a `screen` is an X display in a session's
  workspace that the session's agent sees and drives with `screen_look` and `screen_act`. Anyone who
  can see the session watches it; only the session's owner can `take over` and `hand back`. Mend
  holds every input. The `screen log` records what the screen showed and who acted on it, and its
  `frames` live in Mend's blob store for 30 days. "Desktop" stays the Electron app: never call a
  screen a desktop, and never call a frame or the screen log a recording run.
- Resource nouns (`docs/adr/0019-shared-services.md`, amended 2026-11-01): a `resource` is a
  long-running service a project declares in `.mend/mend.toml` (Postgres, Redis or any image),
  written with its `@` (`@db`). A `project resource` runs one instance for the project; a
  `worktree resource` is a copy for one worktree. Any definition can run at both levels at once; the
  worktree resource wins locally. There is no session level. For Postgres, `shared`, `own` and `off`
  choose the shared database, its own database on the same server, or no project database; shared is
  the default. The `project network` is how a session reaches a resource by name. A `load` replaces
  a database's data and saves the previous data as a dump first. A `Service` keeps its meaning: a
  session's declared port.
- Setup and proof nouns (`docs/adr/0021-setup-session-and-proof-artifacts.md`, partly built): a
  `setup session` is an ordinary, consented session running Mend's prompt to propose a feature map,
  verification instructions and recipes under `.mend/`; its starter's own agent login pays, and its
  result is a change. A `proof artifact` is a selected screenshot or short video of the user's web
  app with the change on a session's screen, attached to a change with its capture checkpoint and
  observation time, or an explicit unknown source. Anyone who can see the change can see it in Mend.
  Copies posted to Slack, T3 Code or GitHub follow that service's access rules; public-repository
  media is public. Artifacts stay as long as the change; ordinary screen-log frames still expire
  after 30 days. A frame is one screen observation, not an artifact. Captures describe what was
  observed, never claim the change works.
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
- Every PR lands on the owner's roadmap page, `~/Developer/OSS/Sealant/roadmap-site/` (outside the
  repositories). When you open a PR in `mend`, `sealant` (Core) or `sealantd` — feature, fix, docs,
  CI or version bump — add `["<repo>", <number>]` to the `prs` of its feature in `roadmap.json`,
  under the version it ships in, then run `node build.mjs` there (it reads live PR states from
  GitHub and writes `index.html`).
- A PR that starts a feature the roadmap lacks adds the feature: a `name` and a one-line
  `description` of what it does and why. A decision only the owner can make goes in `decisions` with
  your `recommendation`; once it is made, remove it and record the outcome in the feature. When
  scope moves between releases, move the feature. If the roadmap directory is missing on your
  machine, say so in your report.
- `pnpm-lock.yaml` is generated, never hand-edited: let `pnpm install` / `pnpm add` write it, and
  commit the result alongside the `package.json` change that caused it — a PR that adds a dependency
  ships its lockfile update.
- After code changes, always run `pnpm format:fix`.
- For type-checking, use `pnpm typecheck`. It runs TypeScript 7's native `tsc` in every package
  except `apps/docs`, whose `astro check` needs TypeScript 6. TypeScript 6
  (`@typescript/typescript6`, catalog `ts6`) is only for tools that load `typescript` as a library;
  never run `tsc6` yourself.
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

## Fix Now or File

While Mend's core features are still being built, fix a problem straight away only if people will
run into it in ordinary use and it does at least one of three things: it makes Mend look like an
unfinished pet project, it stops someone getting their work done, or it loses real work. Anything
else gets filed as an issue for later, including a problem that is rare, hard to reproduce, or
something a developer would understand and work around while the app keeps working. That holds even
when a fix would make the experience nicer and even when it looks small. Three agents designing a
fix, three more attacking it and one reviewing the result costs more than the fix is worth next to
everything still left to build on the roadmap.

Before any fix, write down what a person does to hit the problem ("someone sends a message while…")
and roughly how often that happens. If the trigger needs two events to land within milliseconds of
each other, or was only seen in tests with fakes, it's rare: file it. Reviewers and gates grade
their findings by this rule too. A finding that doesn't meet it is an issue to file, not a failed
review. This rule overrides older rules that call a problem a blocker without asking how often
people hit it.

## Check Features on the Box

A feature merges only after an agent that didn't write it has used it on the box, our live Mend
server, the way a person would. That means real logins, through a `mend` CLI and browser already
signed in as a person, on a `-next` or preview build cut for the PR when the box doesn't run the
code yet. Never sign that CLI in or out, and never read its token. The verdict goes on the PR. It
names the build, the sessions it ran and what it saw. For a feature, a local stack with fake
accounts, a unit test, green CI or reading the code is not a verdict. Test, CI and docs PRs don't
need one.

Spend tokens on that check, not on review panels. Run `interrogate` only when two designs a reviewer
could defend are genuinely in dispute. Otherwise the box check is the feature's one review, graded
by Fix Now or File.

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
