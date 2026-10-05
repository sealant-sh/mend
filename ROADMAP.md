# Roadmap

What each Mend release contains, across `sealant-sh/mend`, `sealant-sh/sealant` (Core) and
`sealant-sh/sealantd`. Written 2026-10-01, after 0.35.1. Update it as items land; a release's
section goes when it ships.

## How releases work

- **A release has a scope, written here.** Pull requests merge to `main` in all three repositories
  when they are ready. Tags wait until the release's scope is done.
- **Main publishes prereleases** ([ADR 0015](docs/adr/0015-next-channel.md)). Every merge to Core or
  sealantd main publishes `B-next.N` under separate names: `-next` images and the `@sealant/*-next`
  npm packages, which are the only packages that workflow can publish. N is the commit's whole
  history and B never falls below a base already published, so each build is higher than the last.
  Mend pins those exact versions on main through aliases
  (`"@sealant/sdk": npm:@sealant/sdk-next@…`), so a Mend change that needs a new Core API waits for
  Core main's CI, not for a Core release. The stable packages and their `latest` move only on a
  stable tag.
- **Mend `next` builds are chosen.** An admin tags `vX.Y.Z-next.N` on main (the version comes from
  `node scripts/next-version.mjs --package apps/cli origin/main`); the release workflow publishes it
  to npm `next` and as a GitHub prerelease, after the owner's approval. That is what goes on the box
  and what people install with `npm install --global @sealant/mend@next`.
- **A stable release is a promotion,** one of each repository per Mend release, in one order
  (`docs/operations/next-channel.md`): sealantd merges its Version Packages pull request and freezes
  main; Core pins that build; sealantd tags it; Core pins the release, merges its own Version
  Packages pull request and freezes main; Core tags after Mend has run that build; Mend pins Core's
  release, cuts a next build and runs it on the box; then Mend tags. The releases refuse a tag that
  leaves out one of its own next builds (a merge during a freeze), Core refuses a prerelease
  sealantd, and Mend refuses a prerelease pin anywhere and any change since its newest published
  next build beyond the Version Packages pull request, notes and docs.
- **Patch releases (0.36.1 and on) are for what is broken** on the box or on alpha: a session that
  cannot start, attach, stop or save. Nothing else gets its own tag. While only patch changesets are
  pending, next builds are `0.36.1-next.N`, so the box proves the patch as the version it ships as.
  Once a minor changeset lands, builds become `0.37.0-next.N` and stay there if it is reverted: a
  server on one of those skips `0.36.1`, and the next release is `0.37.0`.
- **A release is done when its exit criteria hold on the box,** not when CI passes.

## 0.36: Mend on our own box, every day

Mend runs on the Hetzner box (`yiannis-k8s-arc`: i9-9900K, 16 threads, 62 GB, 2 × 1 TB NVMe) and is
used there full time, to find bugs by using it while it is built. 0.36 is the first release shared
with people outside the team, so everything it holds is listed here. State on 2026-10-05, read from
GitHub.

### Shipped on main

Merged since 0.35.1.

- **Agent memory:** one per person per project, shared by that person's sessions on it and private
  to them ([ADR 0009](docs/adr/0009-agent-memory-per-person-per-project.md)). Claude (#461) and
  Codex (#472). Imported on adoption with `mend memory import`.
- **Saves without the wait** (#462, #464, #465, #473, #474, #475, #476): a Stop's save went from 118
  s to 15–19 s on the box.
- **The move onto the box:** CI deploys it (#497, #499, #500). Preview builds of Mend, Core and
  sealantd branches for one box (#463). Every Mend workflow runs on Blacksmith (#468).
- **Models:** one model picker, and the server owns the list (#454, #479).
- **Harnesses:** pi and opencode as terminal sessions, on the connected ChatGPT login (#456, #457).
  `mend connect pi` sends a person's pi setup to every pi session of theirs (#460).
- **Secret files:** a person's credential files, written into every session and never captured
  (#478, [ADR 0010](docs/adr/0010-secret-files.md)).
- **Any project of the store, ad hoc, from inside a session** (#480,
  [ADR 0011](docs/adr/0011-repositories-in-a-session.md)).
- **The packaged server knows its edge and its posture** (#481). A refused worktree removal offers
  Remove anyway, and `mend worktrees rm` (#483).
- **The agent's pull request is recorded and shown** when its turn ends: lists, the phone and the
  web app (#489, #490, #491). Claude workflows show while they run (#488).
- **Fixes:**
  - #486: a session and its run settle together.
  - #487: the phone's Stop reads the interrupt's empty answer.
  - #493: a resumed or followed-up ask session comes back asking.
  - #450: the phone's Stop session asks first, behind "more".
  - #451: AWS MicroVM sessions get the platform's 8 hours by default.
  - #466: the server says when the Docker host refuses user namespaces, and what to run.
  - #469: the dashboard says what each session is doing.
  - #470: stop, rejoin and service logs take the id they are given.
  - #471: a mode handoff starts its successor in the workspace it already has.
  - #507: startup never waits on an executor.
  - #514: resume takes the id it is given.
  - #515: the bundled Sealant worker launches four workspaces at once.
- **T3 Code gateway, phase 0** (#494, #495, [ADR 0012](docs/adr/0012-t3code-gateway.md)).
- **Per-user steering** ([ADR 0013](docs/adr/0013-whoever-sends-a-turn-pays.md), #517): only a
  session's owner types in its terminal (#518); every turn records whose login paid for it (#519).
  Moved up from 0.38.
- **Tests and docs:** #459, #477, #498; #453, #482, #484, #485.
- **Core** (since 0.38.1): sealant#306, #307, #309 (pi in every image), #311, #312 (a stop is
  recorded once the executor has ended), #314 (an exec is read back soon after it ends).
- **sealantd** (since 0.19.0): sealantd#127, #128 (upload URLs bound to their bytes), #130, #131,
  #132, #134 (ADR 0016), #135 (a restore writes files on every core).

### In review, part of 0.36

- **Memory:**
  - #502: an import merges what both sides have changed, against the last import (migration 0108).
  - #528: memory is read back only for the person whose memory a workspace holds, and a launch hands
    the home over between people.
- **opencode:**
  - #503: opens on the ChatGPT login, resumes the right conversation, keeps MCP logins out of saved
    state.
  - #505: opencode's models in the catalog, with no default (migration 0109). Stacked on #503.
  - sealantd#136: every harness credential stays out of saved state and is skipped on restore.
- **Credentials:** #526 keeps one table of harness credential paths, held equal to sealantd's by a
  test. On hold for the owner's per-person home decision.
- **Start time:** #513 (a launch writes its files in a few execs), #516 (a relaunch waits for the
  session's own earlier lease), sealant#313 (reading changes starts from a refreshed copy of the
  index). Not yet measured on the box.
- **Mobile:** #504, a pi session reads "pi", not "OpenCode".
- **T3 Code gateway, phase 1:** #508, #509, #510, #511.
- **Codex:** #527, Codex never starts its background server. Its copy of Codex was about 427 MB in
  saved state.
- **Projects:** #529, Automatic install, on or off per project (migration 0110).
- **The `next` prerelease channel** (ADR 0015): mend#521, #522, #523, #524; sealant#318, #319;
  sealantd#137. #523 merges only after the first Mend next build has published.
- **sealantd image:** sealantd#138, socat comes over HTTPS and is checked against a pinned checksum.
- **Merge order for migrations:** #502 (0108), then #505 (0109), then #529 (0110).

### Carried from the 2026-10-01 scope, no pull request yet

- Mend's wording for Core's planned stop before a runtime's deadline. It reads "stopped outside
  Mend" today.

### Decisions open for 0.36 (owner)

- Per-person harness homes inside a shared worktree, the "split home". Recommended for 0.36.
- opencode's database holds logins next to conversations.
- Whether the steering login switch (sealant#315, #316, then a Mend PR) ships in 0.36.
- A joiner's agent writes into the worktree owner's memory (#528).

### Moved to 0.37

- Seeing and deleting the agent's memory in the web app and on the phone. The CLI has it.
- Doppler (ADR 0014, #501).
- T3 Code gateway, phases 2–4.

### Release chain

With the next channel, a stable release promotes the next builds the box ran: sealantd 0.20.0, then
Core 0.39.0, then Mend 0.36.0. Steps in `docs/operations/next-channel.md` (added by #522).

### Exit criteria

- A week of daily use on the box, with sessions started from the CLI, the phone and the web app.
- A session started on Monday knows what Friday's sessions on the same project learned.
- A stop's save takes under two minutes, measured on the box. Observed: 15–19 s on the box,
  2026-10-03.
- Start time measured on the box against the baseline before #513, #516 and sealant#313: about 90 s
  to the first output for a new session.
- Every pull request above merged or explicitly moved out.
- A box run of opencode, pi and secret files on the release candidate.

## 0.37: Live previews

Preview links for a session's running app, from Slack and the phone, plus services shared by a
project. The plan is in Obsidian (`10 Projects/Sealant/Mend/Mend live preview plan.md`). It needs an
ADR first, and six open decisions: the domain, public links, the shared database model, the setup
cache, idle defaults, and the gateway on a private instance.

## 0.38: Context packs and shared control on the steerer's login

1. **Context packs.** Named, versioned selections of context that a session receives as an immutable
   snapshot (`MEND-AGENT-WORKBENCH-PLAN.md` §5.4).
2. **Shared control, paid by whoever steers.** When a member steers someone else's session, their
   turn runs on their own login: the session's credentials are passed with each turn, on the fly,
   instead of being fixed when the session starts. Today the owner's login pays for every turn (ADR
   0008, "Whose login pays"). Designed in ADR 0013: the switch sits in turn dispatch, the owner's
   login goes back when a steerer's turn ends, Codex restarts its app-server in place after a
   switch, and in a terminal session only the owner types.

## Not scheduled

- **Isolated sessions on our own hardware** (one small VM per session) before people outside the
  team use the box. Docker sessions run privileged, so a shared box is for trusted users only.
- **Flaky tests:** Mend `doctor.test` (spawns the CLI, `docker info` on CI), the `engine.test`
  resume and shell race, Core marketing and docs sharing inspector port 9229, sealantd cadence and
  capture.
- **S3 seal proofs at register time,** so a stop's seal on AWS is instant.
- **Alpha boot time,** about 137 s, up from 100 s.
- **A bigger box,** after a week of measured use on this one.
