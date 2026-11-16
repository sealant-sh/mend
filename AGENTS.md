# Mend Quick Context

Rules and skills shared by every Sealant repo, including Linear, PRs, verification and model choice,
live in the home repo, cloned beside this one at `../agent-home`. Start sessions there when work
spans repos.

Mend (by Sealant) is a `pnpm` + `turbo` monorepo. Mend is a **local-first workbench for developers
who use coding agents heavily**: adopt a repository into Mend's central store, run your own agent
(`mend codex`, `mend claude`, an arbitrary command) in a recorded git worktree, review the
accumulated local change with evidence beside every claim, send review comments back to the same
session, and steer it all from any device, over loopback, a private network, or publicly behind an
edge (ADR 0004). People using Mend need no issue tracker or PR; that describes the product, not how
work on this repo lands.

`PRODUCT.md` says what Mend is and is not: its principles, non-goals and direction. Read it before a
product or UX decision, and check `docs/decisions.md` and `docs/adr/` for decisions already made in
the area. The roadmap is in Linear.

- `apps/api`: the Mend server (Effect HttpApi): sessions engine, store, landing, Slack, workers.
- `apps/cli`: the `mend` CLI (`@sealant/mend` on npm): OpenTUI dashboard, sessions, `mend server`.
- `apps/desktop`: Electron desktop app: every live session as a terminal, review beside it.
- `apps/docs`: the docs site (Astro Starlight), published at docs.mend.run.
- `apps/marketing`: TanStack Start marketing site (Cloudflare Workers via wrangler).
- `apps/mobile`: Expo app: steer sessions and review changes from a phone.
- `apps/t3-gateway`: a t3code environment in front of Mend; t3code's clients pair with it (ADR
  0012).
- `apps/vscode`: VS Code extension: open and steer sessions, workspaces over Remote-SSH.
- `apps/web`: TanStack Start product web app — Now · projects · sessions · review.
- `packages/*`: shared libraries: `agent-conversation`, `agent-protocol` (Codex/Claude stdio
  adapters), `api-contracts` (the HTTP API contract), `auth`, `db` (Postgres, migrations), `domain`,
  `inference`, `jobs` (pg-boss), `landing`, `local-git` (git on the person's machine: handoff
  snapshots), `network`, `sealant` (the SDK behind Effect services), `sessions` (the session
  engine), `slack`, `store` (repository store, worktrees, checkpoints), `t3-contracts` (t3code's
  contracts, copied verbatim), `ui` (design tokens), `workspace-ssh`.
- `tooling/*`: shared configs (`typescript`), build scripts (`scripts`: the server bundler) and CI
  test helpers (`test-ci`).

Mend consumes the Sealant platform **only through the public SDK** (`@sealant/sdk` on npm):
`workspaces.create({ repository, harness })`, blocking `harness.run(prompt)` or non-blocking
`harness.start(prompt)` + `run.record.stream()`, `run.wait()`, `run.changes`, and the replayable
record. **Never import Sealant internals.** If the SDK is missing something Mend needs, file it in
Linear with the `sealant` label instead of working around it.

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
  it; its owner is the owner of the worktree's first session); for the person using Mend, landing a
  change (merge/commit/PR) is publication, optional by definition.
- Platform nouns follow Sealant: `workspace` (the live environment; sessions run in workspaces that
  mount their worktree), `run` (a session is backed by a run and its durable record), `harness`.
- Issues and PRs are optional references attached to work, never its identity. The queue is gone: no
  triage/queued/mending stages, no issue intake, no kanban.
- Evidence, not verdicts: status words describe what was observed ("Completed · observed"), never a
  judgment ("safe to merge"). Mend reports; the human decides.
- Each area has its own nouns. Before writing UI copy, API names, docs, tickets or code for tenancy
  and roles, access and exposure, access keys, Slack, landing, screens, resources, setup sessions
  and proof artifacts, or Executor, read that area's section of the public glossary,
  `apps/docs/src/content/docs/reference/product-language.md`.
- The product model is `apps/docs/src/content/docs/concepts/product-model.md`. The full glossary and
  voice rules are in the public glossary above; design language and UX rules in `DESIGN.md`.

## Linear, Fixes and PRs

- When the work has a Linear ticket, load the `linear` skill
  (`../agent-home/.agents/skills/linear/`) before you start. Keep the ticket current while you work:
  when you make a decision, hit a blocker or change scope, comment on the ticket then, before
  carrying on.
- Fix a problem straight away only if it meets Fix Now or File in `../agent-home/AGENTS.md`. File
  the rest in Linear.
- Every change lands through a PR, docs and config included; never push to `main`. Open it with the
  `file-pr` skill (`../agent-home/.agents/skills/file-pr/`).

## Checks Before a PR

Never open a PR, or push a branch for one, until `pnpm verify check` passes on the commit you push.
It runs typecheck and lint forced, so a warm cache can't lie, the tests of every package the change
affects, and the format check (`pnpm format:fix` fixes it). A test that skips makes it `skipped`,
not `passed`, unless `tooling/verify/allowed-skips.json` allows that skip.

```sh
pnpm verify plan     # what this change owes: gated suites, models, a judge and a run, screenshots, CI jobs
pnpm verify check    # the gate above; add --concurrency 2 on a shared, busy machine
pnpm verify status --markdown   # the receipt for the PR body: one line per obligation for this commit
```

Each prints one JSON result with `--json` and keeps it in `.verify/latest/`. Its `next` lists the
commands that turn a result that did not pass into one that does.

In a fresh worktree, run `pnpm install` before anything else, or `pnpm format:fix` rewrites files
the change never touched. Then run `pnpm build` once: typecheck needs the route trees it generates.
`DEVELOPMENT.md` covers running Mend from source and its tests.

Typecheck runs [tsrs](https://github.com/oxc-project/tsrs), a Rust port of the TypeScript 7 checker,
in every package except `apps/docs`, as `tsrs --checkers 1`. It is in beta and pinned exactly; if
you think it is wrong about an error, compare with `tsc` and report any difference upstream.
`pnpm lint:types` runs oxlint's type-aware rules with tsrs as the type engine
(`OXLINT_TSGOLINT_PATH=…/tsrs-lint`). `apps/docs` runs `astro check`, which needs TypeScript 6.
TypeScript 6 (`@typescript/typescript6`, catalog `ts6`) is only for tools that load `typescript` as
a library; never run `tsc6` yourself.

## Run a Feature Before It Merges

A feature or fix merges only after two things, both on the PR. An agent that didn't write it has
said where it must be run and what a person must see. Its author has then run it there and seen
exactly that. `pnpm verify plan` owes these as `judge` and `run-it` whenever a change touches
product source. Test, CI and docs PRs owe neither.

```sh
pnpm verify judge                         # writes the brief: .verify/judge/<sha>/brief.md
# start one agent that did not write the change; give it the brief and nothing else
pnpm verify judge --record <answer.json>  # keeps its answer for this commit
```

The judge reads the diff and answers two questions. Where: a local stack, or the box when it can
name which thing a local stack can't show (`tooling/verify/local-stack-limits.json` is that list;
change it when a local stack gains or loses an ability). What: three to five things a person does
and sees, and what they would see if the change didn't work. Hand over the brief unchanged. Your
summary of the change, or your view of where it should run, makes the judge agree with you. When you
can't start another agent, answer the brief yourself and record it with `--self`; the receipt then
says the author judged it.

Then run it where the judge said. On a local stack, as the `verify` skill (`.agents/skills/verify/`)
says:

```sh
pnpm verify stack up                                # a real Mend built from this commit, on this machine
pnpm verify drive <surface> --recipe <name|path>    # once per surface the change touches
pnpm verify evidence                                # the secret scan, and the verdict file to post
pnpm verify stack down
```

The verdict goes on the PR. It names the commit, each thing the judge asked for with what you did
and saw, a screenshot of every state a person sees, and what you could not check. A unit test, green
CI or reading the code is not a verdict. The receipt's `run-it` line reads `passed` once
`verify evidence` passes on the commit you push, or, when the judge said the box, once
`verify box identity` does. The terminal has no recipe format yet: drive a CLI change with
`drive-tui.sh`, and name the `skipped` line under the receipt with the transcript.

A judgement is about one commit. After a push that changes what the feature does, judge again; after
one that doesn't, say so under the receipt.

This is the feature's one check. Nobody repeats your run and no review panel follows it. Ask for a
second, independent review (the home repo's `interrogate` skill) only when two designs a reviewer
could defend are genuinely in dispute. Grade what the run finds by Fix Now or File in
`../agent-home/AGENTS.md`.

### The Box

The box is our preview Mend server: VM 131, with Boat set up, or VM 130 (`alpha.mend.run`).
`docs/operations/preview-builds.md` ("The box") says how to reach each. A change goes there when its
judge says so, or when the owner asks; nothing else does. Use it as a person would, through a `mend`
CLI and browser already signed in. Never sign that CLI in or out, and never read its token.

Name the box with `MEND_VERIFY_BOX_SSH` (the ssh arguments that reach it as root), then, in order:

```sh
pnpm verify box plan --pr <n>            # what it runs, whether another check holds it, schema, disk
pnpm verify health                       # from where its app URL answers: here, its host, a container
pnpm verify box prepare --pr <n> --yes   # pg_dumpall to /root/backups, and hold the box
pnpm verify box cli --pr <n> --yes       # a CLI packed from this commit, installed beside the global one
# build and deploy the preview: docs/operations/preview-builds.md
pnpm verify box identity                 # by patch id, the running build contains this change
pnpm verify box release --pr <n> --yes   # when you are done
```

`plan` and `identity` only read; the others change the box only with `--yes`.

## Dependencies

- `pnpm-lock.yaml` is generated: let `pnpm install` / `pnpm add` write it, and commit it with the
  `package.json` change that caused it. A PR that adds a dependency ships its lockfile update.
- Internal dependencies use `workspace:*` in `package.json` and are imported as
  `@mend/<package-name>`, never through `../packages/*` paths.
- An external dependency used by more than one app or package takes its version from the root
  `pnpm-workspace.yaml` `catalog`, referenced as `catalog:`. Add it to the catalog if it is missing.

## Code

- All backend code is Effect v4; see Effect below.
- Write TypeScript to the `coding-standards` skill
  (`../agent-home/.agents/skills/coding-standards/`), including its rules on `any` and casts.
- Before any non-tiny UI change, read `DESIGN.md` and follow it as the design source of truth. Mend
  shares Sealant's Evidence Review design language, and must look like part of the same family.
- This repo is not Next.js: write no `"use client"` directives.
- In React, derive data from props, state and loaders; reach for `useEffect` only when no cleaner
  data flow exists.

## Effect

Before writing Effect code, load the home repo's `effect` skill. It covers services, layers, the
composition root, entrypoints, testing with layers, concurrency and the everyday Effect APIs. Check
every API against the `effect` version installed in `node_modules`, not memory or upstream `main`.

The skill gives every layer an explicit type. Don't skip it here: an un-annotated `static layer` in
a class body can infer `Layer<never>` from its own self-reference and then provide nothing, which
only errors at the far boundary.

<!-- intent-skills:start -->

## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead
of downloading a replacement. Before editing files for a substantial task:

- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing
  files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer
  the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are
changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
