# Roadmap

What each Mend release contains, across `sealant-sh/mend`, `sealant-sh/sealant` (Core) and
`sealant-sh/sealantd`. Written 2026-10-01, after 0.35.1; the 0.36 section rewritten 2026-10-06.
Update it as items land; a release's section goes when it ships.

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
with people outside the team, so everything it holds is listed here. State on 2026-10-06, read from
GitHub. The box runs `0.36.0-next.601` since 2026-10-05.

### Shipped on main

Merged since 0.35.1.

- **Agent memory:** one per person per project, shared by that person's sessions on it and private
  to them ([ADR 0009](docs/adr/0009-agent-memory-per-person-per-project.md)). Claude (#461) and
  Codex (#472). Imported on adoption with `mend memory import`; an import merges what both sides
  have changed, against the last import (#502, migration 0108). Memory is read back only for the
  person whose memory a workspace holds, and a launch hands the home over between people (#528).
- **Saves without the wait** (#462, #464, #465, #473, #474, #475, #476): a Stop's save went from 118
  s to 15–19 s on the box.
- **Start time** (#507, #513, #514, #515, #516; sealant#313, #314; sealantd#135): measured on the
  box on `0.36.0-next.601`, a new session takes about 27 s (was about 90 s) and a resume about 35 s
  (was 62 s).
- **The move onto the box:** CI deploys it (#497, #499, #500), only code on main (#541). Preview
  builds of Mend, Core and sealantd branches for one box (#463). Every Mend workflow runs on
  Blacksmith (#468).
- **The `next` prerelease channel** ([ADR 0015](docs/adr/0015-next-channel.md)): mend#521, #522,
  #523, #524, #531, #532, #533; sealant#318, #319, #321, #322, #323; sealantd#137, #140, #141. Live:
  Core publishes `@sealant/sdk-next@0.39.0-next.683`, sealantd `0.20.0-next.142`, and
  `@sealant/mend@next` is `0.36.0-next.602`.
- **Models:** one model picker, and the server owns the list (#454, #479). opencode's models in the
  catalog, with no default (#505, migration 0109).
- **Harnesses:** pi and opencode as terminal sessions, on the connected ChatGPT login (#456, #457).
  `mend connect pi` sends a person's pi setup to every pi session of theirs (#460). opencode opens
  on the ChatGPT login, resumes the right conversation and keeps MCP logins out of saved state
  (#503). The phone reads "pi" for a pi session (#504).
- **Credential safety:** every harness credential stays out of saved state and is skipped on restore
  (sealantd#136). Codex never starts its background server; its copy of Codex was about 427 MB in
  saved state (#527).
- **Secret files:** a person's credential files, written into every session and never captured
  (#478, [ADR 0010](docs/adr/0010-secret-files.md)).
- **Any project of the store, ad hoc, from inside a session** (#480,
  [ADR 0011](docs/adr/0011-repositories-in-a-session.md)).
- **Projects:** Automatic install, on or off per project (#529, migration 0110).
- **The packaged server knows its edge and its posture** (#481). A refused worktree removal offers
  Remove anyway, and `mend worktrees rm` (#483).
- **The agent's pull request is recorded and shown** when its turn ends: lists, the phone and the
  web app (#489, #490, #491). Claude workflows show while they run (#488).
- **Per-user steering, first part** ([ADR 0013](docs/adr/0013-whoever-sends-a-turn-pays.md), #517):
  only a session's owner types in its terminal (#518); every turn records whose login paid for it
  (#519). Moved up from 0.38.
- **T3 Code gateway, phases 0 and 1** ([ADR 0012](docs/adr/0012-t3code-gateway.md)): #494, #495;
  #508, #509, #510, #511.
- **Feature specs:** 15 specs in `docs/specs/0.36/` (#536), one per 0.36 feature, for adversarial
  review.
- **Fixes from the specs:**
  - #537: a pi profile restored without its `mcp.json` is still the one delivered.
  - #538: a change Core could not read is not shown as empty.
  - #539: only standby workspaces read the shared dependency cache (docs).
  - #540: removing a worktree refuses while its sessions hold added repositories.
  - #541: the box deploys only code on main, and refuses what it cannot check.
  - #542: a resume through a join keeps its conversation.
  - #543: a private project is never added to a worktree others can open.
  - #544: the T3 gateway's state file is its own, and pairing limits are per client.
  - #545: Claude Code never updates itself inside a workspace. A second Claude in a running
    workspace failed on the stub the update left.
  - #546: a Stop made in Mend no longer reads "stopped outside Mend".
  - #548: a joined session's later runs write no secret files into the holder's home.
  - sealant#323, sealantd#141: every main commit gets its own next run.
- **Other fixes:**
  - #486: a session and its run settle together.
  - #487: the phone's Stop reads the interrupt's empty answer.
  - #493: a resumed or followed-up ask session comes back asking.
  - #450: the phone's Stop session asks first, behind "more".
  - #451: AWS MicroVM sessions get the platform's 8 hours by default.
  - #466: the server says when the Docker host refuses user namespaces, and what to run.
  - #469: the dashboard says what each session is doing.
  - #470: stop, rejoin and service logs take the id they are given.
  - #471: a mode handoff starts its successor in the workspace it already has.
  - sealantd#138: socat comes over HTTPS and is checked against a pinned checksum.
- **Tests and docs:** #459, #477, #498, #535 (three flaky CI tests); #453, #482, #484, #485, #547.
- **Core** (since 0.38.1): sealant#306, #307, #309 (pi in every image), #311, #312 (a stop is
  recorded once the executor has ended), #313, #314 (an exec is read back soon after it ends), #318,
  #319, #321, #322, #323.
- **sealantd** (since 0.19.0): sealantd#127, #128 (upload URLs bound to their bytes), #130, #131,
  #132, #134 (sealantd's ADR 0016, repository roots), #135 (a restore writes files on every core),
  #136, #137, #138, #140, #141.

### In review, part of 0.36

- **Per-person harness homes** (Mend ADR 0016, #534, being revised after three design reviews).
  Approved for 0.36 by the owner on 2026-10-05:
  - a Linux user per person, with passwordless sudo. That is not isolation, and the docs say so;
  - one shared conversation under steering, each turn on its sender's login;
  - neutral context under shared control: neither person's personal memory or instructions load,
    only the project's;
  - no person ever uses anyone else's login.

  The steering login switch (ADR 0013) ships in 0.36 as part of it, on sealant#315 (reshaped into
  per-home injection) and sealant#316. #534 plans 21 pull requests across Mend, Core and sealantd;
  the rest are not open yet. #526 (one table of harness credential paths, held equal to sealantd's
  by a test) is on hold and folds into that plan.

- **Found on the box, no fix on main:** a Codex join shows Codex's sign-in screen. A joiner on their
  own login, under per-person homes, covers it.
- **Agent rules:** sealant#324, sealantd#142 (Mend's is #547, merged).

### Decisions open (owner)

- The opencode in-app login exception (ADR 0016 decision 8a, #534).
- Planned stops on AWS: Mend's replacement before a runtime's deadline loses to Core's planned stop,
  which fires first.
- Doppler (ADR 0014, #501): proposed, nine decisions, for 0.37.
- #392, the marketing header on iPhone: merge or close.
- Code-owner review on Core and sealantd main, the next channel's last hardening step.

### Moved to 0.37

- Seeing and deleting the agent's memory in the web app and on the phone. The CLI and the API have
  it.
- Doppler (ADR 0014, #501).
- T3 Code gateway, phases 2–4.
- Mend's words for Core's planned stop before a runtime's deadline (spec in
  `docs/specs/0.36/planned-stop-wording.md`, no pull request). Out of 0.36: only AWS MicroVMs hit
  it, the box runs Docker, and alpha has been torn down since 2026-10-03, so no deployment reads
  "stopped outside Mend" for it today.

### Release chain

A stable release promotes the next builds the box ran: sealantd 0.20.0, then Core 0.39.0, then Mend
0.36.0. Their Version Packages pull requests (sealantd#129, sealant#310, mend#455) merge at release
time, in that order. Steps in `docs/operations/next-channel.md`.

### Exit criteria

- A week of daily use on the box, with sessions started from the CLI, the phone and the web app.
  Open.
- A session started on Monday knows what Friday's sessions on the same project learned. Open.
- A stop's save takes under two minutes, measured on the box. Met: 15–19 s on 2026-10-03, 9–19 s on
  `0.36.0-next.601`.
- Start time measured on the box against the baseline before #513, #516 and sealant#313. Met on
  2026-10-05, `0.36.0-next.601`: a new session about 27 s (was about 90 s), a resume about 35 s (was
  62 s).
- Every pull request above merged or explicitly moved out. Open: per-person homes.
- A box run of opencode, pi and secret files on the release candidate. Open: all three work on
  `0.36.0-next.601`; the release candidate is not cut.

## 0.37: Live previews

Preview links for a session's running app, from Slack and the phone, plus services shared by a
project. The plan is in Obsidian (`10 Projects/Sealant/Mend/Mend live preview plan.md`). It needs an
ADR first, and six open decisions: the domain, public links, the shared database model, the setup
cache, idle defaults, and the gateway on a private instance.

Also in 0.37, moved from 0.36: the memory view in the web app and on the phone, Doppler, T3 Code
gateway phases 2–4, and Mend's words for Core's planned stop. Follow-ups from #531: "changes not
read" in place of an empty diff, from Core's `available` field, and pi on the SDK's native harness.

## 0.38: Context packs

Named, versioned selections of context that a session receives as an immutable snapshot
(`MEND-AGENT-WORKBENCH-PLAN.md` §5.4). Shared control on the steerer's login moved to 0.36, with
per-person harness homes.

## Not scheduled

- **Isolated sessions on our own hardware** (one small VM per session) before people outside the
  team use the box. Docker sessions run privileged, so a shared box is for trusted users only.
- **Flaky tests:** Mend `doctor.test` (spawns the CLI, `docker info` on CI), the `engine.test`
  resume and shell race, Core marketing and docs sharing inspector port 9229, sealantd cadence and
  capture.
- **S3 seal proofs at register time,** so a stop's seal on AWS is instant.
- **Alpha boot time,** about 137 s, up from 100 s.
- **A bigger box,** after a week of measured use on this one.
