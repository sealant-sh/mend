# Repositories in a session: any project of the store, ad hoc, from inside the workspace

Status: proposed 2026-10-03. Cross-repo: sealantd (one capture engine per repository root, the
`repositories` field of `plan.get`; a design PR accompanies this one), Mend (everything below).
Builds on ADR 0001 (linked projects) and ADR 0002 (the capture store). Owner decisions of
2026-10-03, not re-opened here: a CLI inside the workspace makes any project of the store available
ad hoc; each repository keeps its own change; it works in capture mode on the box; the in-workspace
command uses the session's own channel credential and no other.

## Context

The owner develops Mend inside Mend on the box. That work touches three sibling repositories (Mend,
Sealant Core, sealantd), all adopted as projects of the same store. A session has `/workspace/repo`
only. Linked projects (ADR 0001) put a sibling at `/workspace/repos/<name>` through a host mount
bound at launch, which a capture executor cannot have: it mounts nothing. In capture mode the engine
logs `host mounts not applied · references, folders and linked projects stay on this machine`, and
the session record still lists `/workspace/repos/<name>` to the agent, which finds nothing there.
The box runs capture mode.

Three facts shape the design:

- **The worktree is the durable container** (plan §5.5, ADR 0002 "The key is the worktree"). The
  lease, the capture chain, the checkpoints, the change (`worktree_changes`, one row per worktree),
  the review and the landing are all keyed by worktree. A sibling that is a worktree of its own
  project gets all of that for free; a sibling that is anything else gets none of it.
- **sealantd captures one root.** `CaptureConfig.root` is the working directory, `/workspace/repo`
  (`crates/sealantd/src/boot/config.rs` `DEFAULT_WORKING_DIRECTORY`). The git class packs the
  repository at the root, the workspace class carries the root's git-ignored files and its **nested
  repositories** as plain files (`.git/objects` included, kept out of the root repository's tree by
  `:(exclude)` pathspecs), and the bulk class carries bulk-named directories under the root. The
  manifest holds one git section and one workspace root (`manifest.rs` `Sections`). Nothing outside
  the root is listed, watched or restored: a directory at `/workspace/repos/<name>` lives on the
  executor's disk only and is gone at the next executor. sealantd's `tests/nested_repos.rs` proves a
  nested repository round-trips with its history.
- **The in-workspace `mend` is the staged helper**, not the `@sealant/mend` CLI
  (`packages/sessions/src/session-socket.ts` `HELPER_SCRIPT`, linked to `/usr/local/bin/mend`). It
  speaks to the session channel over the session's own token (`MEND_SESSION_TOKEN`, delivered to
  sealantd under the second name `SEALANT_CAPTURE_TOKEN`), which resolves to one launch of one
  session and nothing wider. Its routes are the ones in `session-channel.ts` (`mend service`,
  `mend land`, `mend stop`). Every route must answer within the channel's 30 s request timeout.

## Decision

### Nouns

- A **repository** in a session is another project of the store, present in the session's workspace
  at `/workspace/repos/<name>` as a **worktree of that project**, on a branch of its own for this
  session. `<name>` is a directory name, the project's name unless the person names it. The
  session's own worktree at `/workspace/repo` is the **main repository** in copy.
- A repository is a `worktrees` row of its project. It owns its change, its checkpoints, its review
  and its landing exactly as the main worktree does: the review shows **one change per repository
  the session touched**, and the main repository's change is unchanged.
- The session records which repositories it holds (`session_repositories`): the project, the
  worktree, the name, the path, the branch and base as mirrors, the state (`adding`, `ready`,
  `failed`, `missing`), how it is saved (`nested` or `own`) and where it came from (`origin` or
  `store`). The row is the join the review and the landing use to find the session that holds a
  sibling worktree.

### The command

Inside the workspace, the helper gains a family:

- `mend repo add <project> [--as <name>] [--worktree <name>]` asks Mend to add the project as a
  repository of this session. Mend answers with the row in state `adding` as soon as the worktree
  row exists (its capture 0 is the project base's packs, which the store already holds; a base that
  must be fetched from origin first takes what it takes) and does the clone in its own lifetime,
  which can take minutes. The helper polls `mend repo list` every two seconds, each request with a
  deadline of its own, and prints the row once it is `ready` or `failed`.
- `mend repo list`, also `mend repo`, prints the session's repositories: name, path, branch, state,
  and how each is saved.
- `mend repo projects` prints the projects the session may add: the organization's projects the
  session's owner can see, less the session's own project and the ones already added.

The helper is the in-workspace `mend`, so the agent can run it as well as the person in a shell. The
verbs ride the session channel as `GET /repositories`, `GET /repositories/projects` and
`POST /repositories`, served by `SessionSocketApi` closures that run as the session's owner, as
every channel route does. No new credential: the token the workspace already holds is the only thing
presented. The `@sealant/mend` CLI on a laptop does not gain these verbs here; see "Open".

### Who may add what

The session's owner is the person acting. A project may be added when
`canUseLink(sessionProject, target, owner)` holds (ADR 0001,
`packages/domain/src/workbench/organization.ts`): same organization, and the owner can see both
projects. The session's own project is refused ("already here at /workspace/repo"). A name must
match `^[a-z0-9][a-z0-9._-]{0,63}$` and be unused in the session. The worktree is named after the
session's own worktree unless `--worktree` says otherwise; a worktree of that name already present
in the target project is refused rather than joined (see "Considered options").

### How the worktree arrives

The worktree row, its capture 0 and its change row are made by `ensureWorktreeIn` on the target
project, as any worktree is: the branch is `mend/<worktree name>`, the base is the target's default
branch as Mend holds it in `store_refs`. Then the files reach the workspace:

- **Target, once sealantd carries repository roots:** the daemon materialises the repository from
  Mend's store, from the chain head of its worktree (capture 0 is the project base's git packs,
  exactly how the main worktree arrives), at `/workspace/repos/<name>`. No origin access is needed
  and the base is Mend's recorded base by construction. `plan.get` answers a `repositories` list
  beside the main worktree, and `mend repo add` while the session runs ends in a
  `workspace.capture.replan()`, after which the daemon brings in any repository it does not hold
  yet.
- **Today, shipped in this ADR:** Mend runs a plain `git clone` of the target project's **origin**
  inside the workspace, through the session's git transport. That transport signs with the session
  owner's credential, as every `git` in the workspace does (the Mend key or the owner's bridged
  agent), and it is bound to the main project's origin host (`MEND_GIT_TRANSPORT_BIND_ORIGIN`): a
  sibling whose origin is on another host fails the clone with the transport's own reason, and the
  row reads `failed` with it. The clone then checks out `mend/<name>` at Mend's recorded base sha,
  so the review's A side and the branch agree with the worktree row. A target with no origin is
  refused before anything runs. Why origin and not a fetch from Mend's store: the store speaks no
  git over the channel today (ADR 0002 rejected a stateful git server), and the daemon is the right
  place to materialise from the bucket. The row records `source: origin` so the evidence line says
  where the bytes came from.

### How it is saved

- **Target:** sealantd runs one capture engine per repository root. Each registers under its own
  worktree id and epoch through the same registrar routes, the executor holds one lease per
  repository, a final flush covers every engine, and Mend's capture channel admits the session's
  repositories' worktree ids beside the main one (today `requireWorktree` answers 409
  `wrong-worktree` to any other id). The manifest gains a `repositories` feature (format gate, as
  dir packs did), so an older materialiser is refused rather than left to skip what it does not
  know. This is the sealantd design PR; its Mend half (the channel admitting several worktrees per
  executor, the lease per repository, the plan listing them) follows it.
- **Today, shipped in this ADR:** the clone's directory lives **inside the main worktree**, at
  `/workspace/repo/.mend/repos/<name>`, and `/workspace/repos/<name>` is a symlink to it. sealantd
  carries a nested repository in the main worktree's workspace class, `.git/objects` included, and
  puts its bulk-named directories (`node_modules`, `target`, `dist`) in the bulk class, so every
  capture of the main worktree saves the sibling's files and history, and a pickup or a resume
  restores them with the main worktree. The row records `capture: nested`. Two guards keep the main
  repository's change clean: the daemon's own `:(exclude)` of nested repositories from the root
  tree, and `.mend/` written to the main repository's `.git/info/exclude`, so the agent's
  `git status` and `git add -A` never see it. The symlink is outside the captured root, so Mend
  recreates it at every launch and resume; a repository whose directory did not come back reads
  `missing`. Cost: the first capture after a clone ships the sibling's `.git` as chunked files once,
  then deltas. What the interim does not give: the sibling's own chain stays at capture 0, so Mend
  cannot compute its change from the store, take a checkpoint of it or land it. Its review reads
  `no checkpoints beyond start · saved with the main repository`, never an empty diff presented as
  the truth.

### The change per repository

Each repository's change is its worktree's change row, reviewed at `/changes/<id>` like any other.
The session detail carries `repositories`, one entry per row with its project, its change id and its
checkpoint count, so the session page lists them and the review page names the session's other
repositories beside the one on screen, with a link to each change that has something to show. In the
interim the links are inert because the chains have not moved: the UI says so in those words. When
the daemon captures repositories, `openReview` on a repository's change asks the holding session's
executor for a checkpoint of that root (the via session is the one in `session_repositories`), and
the landing's owner is that session's owner, as `changeOwnerOf` says for the main worktree. The
phone follows later: its review screens are keyed by change id already, so it needs only the
repository list.

### Stop and resume

- **Stop.** Nothing new: the drain's final flush ships the main worktree's workspace and bulk
  classes, the nested repository among them (interim), or every engine's final capture (target). A
  Stop never loses a sibling's uncommitted work.
- **Resume and pickup.** The daemon restores the head capture, which brings the nested directory
  back; Mend then recreates `/workspace/repos/<name>` for each `ready` row before the harness starts
  and marks a row `missing` when its directory is not there. In the target design the plan lists the
  repositories and the daemon materialises each from its own chain. Moving from the interim to the
  target is one step per session: the first launch under a daemon that speaks repositories moves the
  nested directory to `/workspace/repos/<name>` and asks the daemon to adopt it, registering what is
  there as the repository chain's first real capture. Nothing is re-cloned and nothing is lost.
- **Hot pool.** Unchanged. Nothing repository-shaped enters the fingerprint; a claimed standby adds
  repositories as a cold launch does.

### Linked projects

Kept as a **declared shortcut**, not as a mount. A link on a project means "add this project as a
repository at launch"; in capture mode that is what it will do, through the same path as
`mend repo add`, with a worktree per session rather than ADR 0001's one worktree shared by every
session of the project. Until that lands, capture mode stops recording linked projects on the
session as extra mounts, so the agent's note no longer names a directory that does not exist. The
co-located store keeps its bind for one release, as it keeps everything else.

## Considered options

- **A second capture root in sealantd first, ship nothing until then.** Right shape, wrong order:
  the owner's dogfood needs the sibling now, and the nested interim loses nothing. The daemon change
  is designed here and opened as its own PR.
- **Clone at `/workspace/repos/<name>` as a real directory today.** Simplest, and lost at every
  Stop, resume and pickup, since nothing outside the root is captured. Rule one of this product is
  no loss of work product; refused.
- **Nest it and read its change from the main worktree's workspace class.** Mend could materialise
  `tree/.mend/repos/<name>/` from the head capture into a runner cache and diff it. It works, it is
  throwaway the day the daemon captures repositories, and it reads a sibling's objects as chunked
  files rather than verified git packs. Not built; the row says what the review can show instead.
- **sealantd `sources`.** The plan's `sources` land a read-only archive under `/workspace`, capped
  at 64 MiB, re-extracted at every replan, with nothing travelling back. The opposite of a worktree.
- **Fetch from Mend's store over the git transport.** A `mend` pseudo-host spawning
  `git upload-pack` on the runner cache would serve the base without origin access. It adds a git
  server to the channel that ADR 0002 chose not to have, and the daemon will materialise from the
  bucket instead. Not built.
- **Join an existing worktree of the target by name.** `ensureWorktreeIn` joins by name, but the
  interim clone would start from the base while the existing worktree's captured work stays in its
  chain: a silent divergence. Refused until the daemon materialises from the chain, when a join is
  exactly a claim of that worktree's lease.
- **Pushing the sibling's work to a hidden ref on origin at Stop** would put Mend refs on the
  person's remote. Refused.

## Consequences

- The data model does not bend: a repository is a worktree, so review, checkpoints, landing and
  removal rules apply unchanged once its chain moves. The only new table is the session's list.
- In the interim a repository's chain sits at capture 0 while its files travel with the main
  worktree. Mend says exactly that and offers no diff, no checkpoint and no landing for it. Pushing
  from inside the workspace works as it always did (the transport signs as the owner), so the owner
  can land sibling work by hand today.
- A sibling whose origin is on a different host than the main project's cannot be added today
  (`bind origin`). The daemon path removes the dependence on origin access altogether.
- The first capture after a clone grows by the sibling's `.git`, once. CDC chunking carries the
  deltas after that.
- A worktree row in the target project exists with no session of its own. Project pages show it;
  removal is refused while the holding session is live, as for any worktree with live work. The
  branch name is reserved in the target project, which is what makes the later landing honest.
- Capture mode no longer tells the agent about linked repositories it cannot see.

## Decisions made here

1. The in-workspace verbs live in the staged helper (`mend repo add|list|projects`), because that is
   the `mend` the workspace has; the `@sealant/mend` CLI is untouched.
2. Table `session_repositories`, migration `0103_session_repositories`; domain `SessionRepository`
   in `packages/domain/src/workbench/repository.ts`; repository `SessionRepositoriesRepo` in
   `packages/db/src/repos/session-repositories.ts`.
3. Paths: `/workspace/repos/<name>` is the repository's path; `/workspace/repo/.mend/repos/<name>`
   is where the interim keeps it. Both are domain constants.
4. A repository's worktree is named after the session's own worktree unless `--worktree` says; its
   branch follows the worktree (`mend/<name>`); its base is the target's default branch as held in
   `store_refs`.
5. `POST /repositories` answers 202 with the row in `adding` once the worktree row exists; the clone
   runs detached in the engine's lifetime as the owner; the helper polls. Making the worktree row
   first is what keeps `worktree_id` non-null on the session's row; moving the worktree's own
   creation behind the answer too would need that column nullable and is left for the daemon path,
   where capture 0 is the only remote work.
6. States: `adding`, `ready`, `failed` (with the reason), `missing` (ready once, not found after a
   restore). The clone leaves a ready mark, a regular file at `/workspace/repo/.mend/ready/<name>`
   (a directory of its own, so no repository name can collide with it), as its last step; a relink
   trusts only a directory with the mark, so an add the server did not see end (a restart between
   the checkout and the row's `ready`) is settled at the next launch from what the workspace holds:
   `ready` with the mark, `failed` without it, with the directory kept. A `failed` row whose files
   and mark are there after all (the clone's answer was lost, not the clone) comes back `ready`. The
   relink runs at every launch, a fresh one and one into a retained workspace alike.
7. The row records `capture: nested | own` and `source: origin | store` so every surface can say how
   the sibling is saved and where it came from.
8. Refusals, in the channel's words: own project, unknown or invisible project, a name already used,
   a name or a worktree name that is not a directory name, a worktree name already present in the
   target, a target with no origin, a session with no live workspace, a directory that is not Mend's
   link at the repository's path, `.mend` or a directory under it being a link (the captures would
   carry the link, not the files). The worktree-taken check runs last before the worktree is made,
   and the worktree is made by a create-only path (`createWorktreeIn`, the create half of
   `ensureWorktreeIn`): two adds racing for one name in the same instant are separated by the branch
   ref and the worktrees table's unique name, which fail the second create rather than handing it
   the first one's worktree.
9. Capture mode records no linked-project extra mounts on the session.
10. The web shows repositories on the session page and names them on the review page; the phone
    follows later.

11. The exclude line is written through
    `git rev-parse --path-format=absolute --git-path info/exclude`, so it lands in the right git dir
    whether `/workspace/repo` is a repository of its own (capture mode) or a linked worktree whose
    `.git` is a file (the co-located store). Workspace images need git 2.31 or later for
    `--path-format`; every image family Mend ships has it.
12. A relink moves a row only on an explicit observation (`ready`, `missing`, `partial`, `occupied`,
    `outside`): an unreported row keeps what it said, so a relink that could not run never turns a
    saved repository into `missing`. Nothing the relink does can fail the launch; only the launch's
    own interruption passes through.
13. The sealantd half is designed in sealantd ADR 0016 (sealant-sh/sealantd#134); this ADR ships
    with sealant-sh/mend#480.
14. A session's detail lists only the repositories whose project the caller can see: a private
    sibling added to a session in a shared project stays private to those who may see it.
15. Removing a worktree counts the sessions that hold it as a repository among its members: their
    owners have a say, a holder that is live or `stopping` refuses the removal, and so does a
    capture hold on the holder's own worktree, since that is where the repository's files travel
    today. Removing a project is refused while a session of another project holds one of its
    worktrees as a repository and is live or `stopping`.
16. The helper bounds every request of `mend repo add` with one wall-clock timer, connect and
    response alike, and caps each poll by what is left of the thirty-minute budget.
17. Removing a worktree whose sessions added repositories is refused without `force`, as for an
    unlanded change, naming each repository (2026-10-05). Their files and history live nested inside
    that worktree, outside its change (`.mend/` is excluded), and go with it; Mend reads none of
    them in the interim, so each one counts as work that may not be on origin. A repository saved
    under its own captures does not go with the worktree and is not counted.

## Open

- The `@sealant/mend` CLI could gain `mend repo add <session> <project>` for a laptop; not here.
- `mend repo remove <name>`: a worktree removal verb exists per project; the in-session verb waits
  for the daemon path, where removal also ends a lease.
- The move from `nested` to `own` at the first capable daemon is described above and implemented
  with the daemon change.
