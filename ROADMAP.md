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

Mend moves onto the Hetzner box (`yiannis-k8s-arc`: i9-9900K, 16 threads, 62 GB, 2 × 1 TB NVMe) and
is used there full time, to find bugs by using it while it is built.

### Must

1. **One agent memory per person per project.** Shared by that person's sessions on the project,
   private to them. A session starts with the agent's memory in place and saves what it learned back
   when it ends. Proposed in [ADR 0009](docs/adr/0009-agent-memory-per-person-per-project.md): the
   memory is carried, not the whole harness home, which would break resume and transcript discovery.
   Every session's agent runs in `/workspace/repo`, so Claude's memory key is the same in each.
   Claude only for now; Codex builds memory from rollouts a session does not bring.
2. **Import on adoption,** through the CLI, from the person's own machine (owner decision
   2026-09-28):
   - Claude: `~/.claude/projects/<repo path>/memory/*.md`.
   - Codex: `memories_1.sqlite`, filtered to this repository's threads by each thread's working
     directory. Never copied whole.
   - "Bring your previous sessions for this repo?" Yes also imports the transcripts. They are opt-in
     because they hold pasted secrets.
   - Never imported: goals, logins (`.credentials.json`, `auth.json`), logs, caches.
3. **Self-host saves without the wait.** On Docker with Garage a seal takes about ten minutes today.
   Bring it to one or two. Check what is still slow after 0.35.0's "a launch waits for a saving
   predecessor" (#432). Notes so far: sealantd fetches a fresh URL for every upload, with no clock
   margin when co-located.
4. **The move.** `mend server setup` on the box, the Caddy edge in front, DNS. The Kubernetes and
   Ceph clusters stop; their definitions stay in the repository (deployment options are product).
   The box's Minecraft servers are the owner's call.

5. **Models, on the phone first.** The phone needs a working model choice now, and models in general
   need UX work. Start with an audit across the phone, the web app, the CLI and the desktop: what
   each offers, the picker, effort, per-harness defaults, and whether a session says which model it
   runs on. Then one model picker, the same on every client.

6. **pi and opencode as harnesses,** next to Claude and Codex: a session on either, with its own
   agent home (memory, settings, login) handled the same way, since 0.36 reworks the harness homes
   anyway. opencode starts today as a bare command; pi is new.

### Should

- See and delete what the agent remembers, in the web app and on the phone.

### Already open, ships with it

- sealant#307 (one pinned vitest, so CI's lockfile-free install stops splitting it) and sealant#306
  (an idle interval's upload throughput no longer stops a MicroVM early).
- mend#450 (the phone's Stop session asks first, behind "more") and mend#451 (AWS MicroVMs get 8
  hours by default).
- Mend's wording for Core's planned stop before a runtime's deadline. It reads "stopped outside
  Mend" today.

### Exit criteria

- A week of daily use on the box, with sessions started from the CLI, the phone and the web app.
- A session started on Monday knows what Friday's sessions on the same project learned.
- A stop's save takes under two minutes, measured on the box.

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
