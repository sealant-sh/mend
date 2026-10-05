# Any project of the store, ad hoc, from inside a session

- **Release:** 0.36
- **Status:** on main (the interim: nested clone). The target design (sealantd captures each
  repository root) is designed, not built.
- **PRs:** mend#480 (the feature), mend#482 (renumbered the ADR to 0011); sealantd#134 (ADR 0016,
  design only).
- **Decision records:** docs/adr/0011-repositories-in-a-session.md (status: proposed 2026-10-03);
  sealantd docs/adr/0016-repository-roots.md (proposed, "Nothing here is built yet"). Builds on ADR
  0001 (linked projects), ADR 0002 (capture store), ADR 0003 (tenancy).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

The owner develops Mend inside Mend on the box, across three sibling repositories (Mend, Sealant
Core, sealantd), all adopted as projects of one store. A session had `/workspace/repo` only. Linked
projects (ADR 0001) put a sibling at `/workspace/repos/<name>` through a host mount, which a capture
executor cannot have: it mounts nothing. In capture mode the engine logged
`host mounts not applied · references, folders and linked projects stay on this machine`, and the
agent's note still named `/workspace/repos/<name>`, where it found nothing. A sibling cloned by hand
outside `/workspace/repo` is lost at the next Stop, resume or pickup: sealantd captures one root.

Owner decisions 2026-10-03: a CLI inside the workspace makes any project of the store available ad
hoc; each repository keeps its own change; it works in capture mode on the box; the in-workspace
command uses the session's own channel credential and no other.

## What it does

Inside a session's workspace (a shell, or the agent itself), the in-workspace `mend` gains:

- `mend repo add <project> [--as <name>] [--worktree <name>]`. Prints
  `adding <name> · /workspace/repos/<name> · branch mend/<worktree> · cloning`, polls every 2 s,
  then prints the row:

  ```
  core            /workspace/repos/core         mend/fix-capture          ready · saved with the main repository
  ```

  On failure it exits 1 with `<name> · failed · <reason>`. After 30 minutes it prints
  `still adding · mend repo list shows it when done` and exits 0.

- `mend repo list` (also `mend repo`): one line per repository: name, path, branch, state, the
  reason when there is one, and `saved with the main repository` when ready. With none:
  `no repositories beside /workspace/repo · mend repo add <project> adds one`.
- `mend repo projects`: the projects the session may add, with default branch and origin (or
  `no origin`). With none: `no other project of the store can be added here`.

What Mend does on an add:

- makes a worktree of the target project named after the session's own worktree (or `--worktree`),
  on branch `mend/<worktree name>`, based on the target's default branch as the store holds it, with
  its capture 0, its start checkpoint and its change row;
- records the repository on the session (`session_repositories`) in state `adding` and answers;
- clones the target's **origin** inside the workspace through the session's git transport (signed as
  the session's owner), at `/workspace/repo/.mend/repos/<name>`, checks out the branch at the
  recorded base sha, links `/workspace/repos/<name>` to it, and leaves a ready mark;
- marks the row `ready`, or `failed` with the reason.

What a person sees elsewhere:

- **Web session page:** a "Repositories" card: `<path> · <branch>` with a state dot, then
  `<project> · base <ref> · no checkpoints beyond start · saved with the main repository` (or the
  row's reason). With none:
  `none beside /workspace/repo · mend repo add <project> in the session adds one`.
- **Web review page** of the session's change:
  `repositories · /workspace/repos/core ready · nothing of its own to review yet`.
- **The agent's note** (`## Mend repositories`): the ready repositories with their branches, and
  `Need another repository of the store beside this one? mend repo add <project> … Never clone a sibling by hand outside /workspace/repo: only what Mend adds is saved with the session.`
- **Capture mode** records no linked-project mounts on the session, so the note no longer names a
  directory that is not there.

**Defaults.** The repository's name is the project's name; the worktree's name is the session's
worktree name; the base is the target's default branch in `store_refs`. No settings change this.

**In scope.**

- The three helper verbs and their channel routes.
- Who may add what; every refusal.
- Bringing the files in (clone of origin), saving them (nested in the main worktree's captures),
  relinking them at every launch, the four states.
- The session detail's repository list and its visibility filter; the web session and review pages.
- Worktree and project removal while a session holds a repository.
- Capture mode dropping linked-project mounts from the record.

**Out of scope.** The interim, per ADR 0011:

- A repository's own diff, checkpoints and landing. Its chain stays at capture 0, so the review says
  `no checkpoints beyond start` and offers no diff. Pushing from inside the workspace works as for
  any git command, signed as the owner.
- `mend repo remove`.
- `mend repo` on the laptop `@sealant/mend` CLI.
- Joining an existing worktree of the target (refused).
- Repositories on the phone, desktop, VS Code, Slack and the t3 gateway.
- Linked projects as "add this repository at launch" (follow-up).
- Materialising from Mend's store instead of origin (the sealantd ADR 0016 path).

## How it works

### Data

1. Table `session_repositories` (migration `0103_session_repositories`,
   `packages/db/src/migrations.ts:2877`): `session_id` (cascade with the session), `project_id`
   (cascade with the project), `worktree_id` (cascade with the worktree), `name`, `path`, `branch`,
   `base_sha`, `base_ref`, `state` (`adding|ready|failed|missing`, default `adding`), `error`,
   `capture` (`nested|own`), `source` (`origin|store`), `added_by_user_id`, times, `ready_at`.
   Unique `(session_id, name)` and `(session_id, worktree_id)`. Repo:
   `packages/db/src/repos/session-repositories.ts`.
2. Domain: `packages/domain/src/workbench/repository.ts`.
   `REPOSITORY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/`;
   `repositoryPath(name) = /workspace/repos/<name>`;
   `nestedRepositoryPath(name) = /workspace/repo/.mend/repos/<name>`;
   `NESTED_REPOSITORIES_EXCLUDE = ".mend/"`; `repositorySavedWords` →
   `saved with the main repository` / `saved under its own captures`.

### The command and the channel

3. The helper is the staged in-workspace `mend` (`packages/sessions/src/session-socket.ts`,
   `HELPER_SCRIPT`, the `repo` group at line 263), linked at `/usr/local/bin/mend`. It speaks to the
   session channel with the session's own token (`MEND_SESSION_TOKEN`), which resolves to one launch
   of one session. `add` bounds the whole command at 30 minutes: the POST with a 5 minute deadline,
   then each poll with `min(30 s, what is left)`.
4. Routes (`packages/sessions/src/session-channel.ts:191-208`): `GET /repositories`,
   `GET /repositories/projects`, `POST /repositories` (`{project, name?, worktree?}`, answers 202
   with the row). A refusal is 422 with the message. The closures run as the session's owner
   (`ownedSocketApi`, `engine.ts:1872`).

### Adding (`packages/sessions/src/engine.ts:10757-11060`)

5. `addableProjects` (line 10778): the owner's organization's projects, less the session's own and
   those already held, for which `canUseLink(sessionProject, candidate, owner)` holds
   (`packages/domain/src/workbench/organization.ts:141`: same organization, the owner can see both).
6. `addRepository` (line 10861) checks, in this order, each a `RepositoryAddError` with the person's
   words:
   1. the owner belongs to an organization (`not-visible`);
   2. a project of that name exists in the organization (`unknown-project`:
      `no project named "x" · mend repo projects lists what can be added`);
   3. it is not the session's own (`own-project`:
      `<name> is this session's own project · it is at /workspace/repo`);
   4. `canUseLink` (`not-visible`);
   5. the repository name matches `REPOSITORY_NAME` (`bad-name`, suggests `--as`);
   6. the session has no repository of that name (`name-taken`);
   7. the target has an origin (`no-origin`);
   8. the worktree name matches `REPOSITORY_NAME` (`bad-name`, suggests `--worktree`);
   9. the session has a live workspace (`not-live`);
   10. the target has no worktree of that name (`worktree-taken`), read last before the create;
   11. the target is a project Mend supports (`refuseUnsupportedProject`: SHA-256, reftable).
7. `createWorktreeIn` (line 6418) on the target, create-only (never joins): the branch and worktree
   in the target's store, the `worktrees` row (unique name is the race backstop), capture 0 and the
   chain in capture mode (`attachWorktree`), the `session-start` checkpoint, the change row.
8. The `session_repositories` row is created with `capture: "nested"`, `source: "origin"`,
   `addedByUserId: owner`. Then `bringRepositoryIn` is detached into the engine's lifetime, run as
   the owner (`asSealantUser`), and the row is returned.
9. `bringRepositoryIn` (line 10813) execs `repositoryCloneScript`
   (`packages/sessions/src/session-repositories.ts:75`), `set -eu`:
   - writes `.mend/` into the main repository's `info/exclude`, found with
     `git rev-parse --path-format=absolute --git-path info/exclude` (works for a repository and for
     a linked worktree whose `.git` is a file; needs git ≥ 2.31);
   - refuses if `/workspace/repo/.mend`, `.mend/repos` or `.mend/ready` is a link (exit 67), before
     and after `mkdir -p`;
   - refuses if the nested directory exists (exit 65) or the link path exists and is not a link
     (exit 66);
   - `git clone --quiet --no-checkout -- <origin> <nested>`, then
     `git -C <nested> checkout --quiet -B mend/<worktree> <baseSha>`;
   - `ln -sfn <nested> /workspace/repos/<name>`; `: > /workspace/repo/.mend/ready/<name>`. Exit 0
     sets `ready`. Otherwise `failed` with: exit 65
     `<nested> already holds files that are not this repository`; 66
     `<path> is a directory that is not Mend's link · nothing was cloned`; 67
     `/workspace/repo/.mend is a link, not a directory inside the worktree · nothing was cloned`;
     else the last three lines of stderr (`failureReason`, at most 500 characters).
10. The clone goes through the workspace's git transport, which signs as the owner (Mend key or the
    owner's bridged agent) and is bound to the main project's origin host
    (`MEND_GIT_TRANSPORT_BIND_ORIGIN`). A sibling on another host fails with the transport's reason.

### Saving

11. The nested directory is inside `/workspace/repo`, sealantd's capture root. sealantd carries a
    nested repository as plain files in the main worktree's workspace class, `.git/objects`
    included, keeps it out of the main repository's tree with `:(exclude)` pathspecs, and puts its
    bulk-named directories in the bulk class. Every capture of the main worktree saves the sibling's
    files and history; a resume or pickup restores them. The `/workspace/repos/<name>` link is
    outside the root and is not captured.
12. The main repository's change, review and landing do not see `.mend/` (the exclude, and the
    daemon's pathspec exclusion).
13. In the co-located store the nested directory lives in the main worktree's directory on the host;
    it persists with that worktree.

### Relinking at every launch

14. `relinkRepositories` (line 10993) runs at the cold launch (`engine.ts:11917`) and at every
    launch into a retained or joined workspace (`launchInRetainedWorkspace`, `engine.ts:12689`),
    after the harness-home relocation and before the harness. It execs `repositoryRelinkScript`
    (`session-repositories.ts:126`) for every row and reads one word per name:
    - `outside` (`.mend` or a child is a link): `adding` → `failed`, else `missing`;
    - `occupied` (a non-link directory at the path): `failed`, files kept at the nested path;
    - `ready` (nested `.git` directory and the ready mark): relinked; any state → `ready`;
    - `partial` (nested exists, no mark): `adding` → `failed`
      (`the add was interrupted · what it brought in is kept at <nested>`), else `missing`;
    - `missing`: `adding` → `failed` (`the add was interrupted before anything was brought in`),
      else `missing` (`not found in the restored workspace at <nested>`);
    - `unlinked`: logged only. A `failed` row moves only to `ready`. A row the script did not report
      keeps its state. Nothing the relink does fails the launch; only the launch's own interruption
      passes through.
15. The workspace note is rewritten after the relink (`appendWorkspaceNote`, `engine.ts:9353`),
    listing the `ready` rows.

### Reading and removal

16. `GET /sessions/:id` (`apps/api/src/routes/workbench.ts:2331-2353`): `repositories` is the rows
    filtered by `ProjectAccess.filterByProject` (only projects the caller can see), each with its
    project name (`null` once removed), its change, and `checkpointsBeyondStart`.
17. Web: `RepositoriesCard` (`apps/web/src/routes/sessions.$sessionId.tsx:580`),
    `repositoryReviewWords` (line 567); review page naming (`routes/changes.$changeId.tsx:285-309`).
    A link to a repository's change appears only when its chain moved, which the interim never does.
18. Removing a worktree (`apps/api/src/routes/worktrees.ts:173-237`): sessions holding it as a
    repository count among its members. A non-manager is refused unless they own every member. A
    holder that is live or `stopping` refuses (`WorktreeActive`). A capture hold on the holder's own
    worktree refuses (`not removed · a session holding this worktree as a repository is … `). Then
    the worktree row is deleted and the `session_repositories` row cascades.
19. Removing a project (`workbench.ts:676-690`): refused while a session of another project holds
    one of its worktrees as a repository and is live or `stopping`
    (`not removed · a session of another project holds <project> as a repository at <path> and is <status> · stop it first`).
20. Capture mode records no linked-project extra mounts (`engine.ts:9197-9208`).

### Concurrency, ordering, restart

- Two adds of one worktree name in the same instant: the second create fails at the worktree's
  unique name or the branch ref, never joins the first's worktree.
- Two adds of one repository name with different worktree names: both create a worktree; the second
  row insert fails `(session_id, name)` and answers `name-taken`. See Divergences.
- The clone runs detached in the engine's lifetime. A Mend restart mid-clone leaves the row `adding`
  until the session's next launch, whose relink settles it from the workspace (`ready` with the
  mark, `failed` without, files kept).
- A Stop during a clone: the drain's final flush saves what is in the nested directory; the row
  stays `adding` until the next launch settles it.

## Happy path

Capture mode, the box. Projects `mend`, `core` and `sealantd` are shared projects of Alice's
organization, all with GitHub origins on the same host.

1. Alice runs `mend claude "make the stop path faster" --project mend`. The session's worktree is
   `fast-stop`, branch `mend/fast-stop`.
2. The agent reads its note, runs `mend repo projects` and sees:

   ```
   core                      main              git@github.com:sealant-sh/sealant.git
   sealantd                  main              git@github.com:sealant-sh/sealantd.git
   ```

3. The agent runs `mend repo add core`. It prints
   `adding core · /workspace/repos/core · branch mend/fast-stop · cloning`. About a minute later:
   `core  /workspace/repos/core  mend/fast-stop ready · saved with the main repository`.
4. Project `core` now has a worktree `fast-stop` at `main`'s recorded sha with a `session-start`
   checkpoint. Alice's web session page lists `/workspace/repos/core · mend/fast-stop` with a
   `ready` dot and
   `core · base main · no checkpoints beyond start · saved with the main repository`.
5. The agent edits files in both `/workspace/repo` and `/workspace/repos/core`. `git status` in
   `/workspace/repo` shows only the main repository's files.
6. Alice presses Stop. The drain's final flush saves both. The next day she resumes. The new
   executor restores the head; the relink recreates `/workspace/repos/core`; the row stays `ready`;
   the agent's uncommitted edits in `core` are there.
7. Alice opens a shell resume, `cd /workspace/repos/core`, commits and
   `git push origin mend/fast-stop`; she opens the pull request by hand. Mend's review of the `core`
   worktree still reads `no checkpoints beyond start`.

## Invariants

1. No step of an add, relink or removal deletes a repository's files: an interrupted add, a
   directory at the wrong place, a link where a directory belongs, all leave the files where they
   are and say where.
2. A repository is added only for a project the session owner can see, in the same organization, and
   never for the session's own project.
3. The add uses no credential but the session's channel token, and the clone signs as the session's
   owner only.
4. An add never joins an existing worktree of the target project.
5. A repository's files are carried only inside the main worktree's captured root (interim); nothing
   is written under `/workspace/repos/<name>` except the link.
6. The main repository's `git status`, change, review and landing never include `.mend/`.
7. A relink moves a row only on an explicit observation; a failed or partial relink never turns a
   saved repository `missing`, and never fails the launch.
8. `GET /sessions/:id` never names a repository whose project the caller cannot see.
9. A worktree held as a repository by a live or `stopping` session cannot be removed, nor can its
   project.
10. The review never shows an empty diff as a repository's change: it says
    `no checkpoints beyond start`.
11. Every refusal is in words, with the flag that fixes it where there is one.

## Edge cases and failure behaviour

**Concurrent actions**

- Two `mend repo add core` at once: the second answers `name-taken` or `worktree-taken`; nothing is
  cloned twice into one place (exit 65 guards the nested path).
- An add while the session stops: the add may still create the worktree; the clone runs in the dying
  executor, and the next launch settles the row.

**Restarts**

- Mend server restarts mid-clone: the row reads `adding` until the next launch; the helper keeps
  polling and times out after 30 minutes with `still adding · mend repo list shows it when done`.
- Executor lost mid-clone: the next launch's relink reads `partial` (`failed`, files kept) or
  `missing` (`failed`).
- sealantd restore without the nested directory (a capture taken before the clone landed): `missing`
  for a ready row.

**Partial failures**

- The clone fails (auth, network, wrong host, base sha not on origin): `failed` with git's last
  lines. The worktree in the target and the repository name stay taken; a retry needs `--as` and
  `--worktree`.
- Origin on another host than the main project's: refused by the transport; `failed`.

**Odd input**

- A project whose name has uppercase letters: `bad-name` unless `--as`.
- `--as` or `--worktree` with `/`, `..`, spaces: `bad-name` before anything is made.
- `mend repo add` without a project:
  `usage: mend repo add <project> [--as <name>] [--worktree <name>]`.
- `.mend` made a link by the agent: `failed`/`missing` with `outside`, files kept.
- A directory the agent created at `/workspace/repos/<name>`: `occupied`, files at the nested path
  kept.
- `git clean -fdx` in `/workspace/repo`: the `.mend/ready/<name>` marks are ignored files and are
  removed; nested repositories with `.git` are kept unless `-ff`. The next relink reads `partial` →
  `missing`, files kept.

**Older data**

- Sessions from before 0103 have no rows; the card says none.
- Linked projects on a capture-mode session: no longer recorded as mounts; the note does not name
  them.

**Permissions**

- Owner: adds through their shell or their agent.
- Steerer of a shared session: cannot open a shell (ADR 0013), but a conversation turn can ask the
  agent to run `mend repo add`; the add runs as the owner, judged by the owner's visibility, cloned
  on the owner's credential.
- A member who cannot see the sibling project: the session detail leaves it out.
- Operator: no organization content.

**Clients**

- In-workspace helper: the only way to add.
- Web: session page card and review page line.
- CLI on a laptop, desktop, VS Code, phone, Slack, t3 gateway: nothing in 0.36; the sibling's files
  are visible only inside the workspace.
- Co-located store: works the same; the nested directory sits in the main worktree on the host. A
  linked project bound at `/workspace/repos/<name>` occupies the path, so an add of that name fails
  `occupied`.

## Known limits

From ADR 0011 "Consequences" and "Open":

- No diff, checkpoint or landing for a repository until sealantd captures repository roots (sealantd
  ADR 0016). Push by hand.
- A sibling whose origin is on another host cannot be added (`bind origin`).
- The first capture after a clone ships the sibling's `.git` once.
- A worktree row in the target project exists with no session of its own; project pages show it.
- No `mend repo remove`; no laptop CLI verb.
- The note is written at launch; a repository added mid-session appears in the note at the next
  launch.

## How to verify

**Tests.**

- `packages/sessions/test/session-repositories.test.ts`: the clone script (nested, branch, exclude,
  refusals 65/66/67, base not on origin), the relink script and report, quoting, reasons.
- `packages/sessions/test/engine.test.ts:8518`: add to a live session, the refusals.
- `packages/sessions/test/session-channel.test.ts:601`: the helper prints
  `ready · saved with the main repository`.
- `packages/domain/src/workbench/repository.test.ts`, `packages/db/test/schema.test.ts:689`,
  `apps/api/src/routes/workbench.test.ts` (detail filter, removal).
- Not covered: a real resume restoring a nested repository end to end; a Mend restart mid-clone;
  co-located with linked projects.

**By hand on the box.**

```sh
mend claude -d --project mend        # a live session; note its id
mend shell <session-id>              # a shell in its workspace
mend repo projects
mend repo add core
mend repo list
git -C /workspace/repo status --short   # no .mend
ls -l /workspace/repos/                 # core -> /workspace/repo/.mend/repos/core
cat "$(git -C /workspace/repo rev-parse --git-path info/exclude)" | grep -x .mend/
```

Stop, resume, and check `mend repo list` still reads `ready` and the edits are there.

**Signals.** Logs `session engine: repository adding`, `repository added`, `repository not added`,
`repositories relinked`, `repositories relink reported partly`, `repository not linked`.

## Divergences found while writing

- `apps/api/src/routes/worktrees.ts:253-257`: removing a session's own (main) worktree deletes its
  chain, which is where every nested repository's files live, and nothing checks for them: the
  unlanded-work check reads only the main change, which excludes `.mend/`. Uncommitted work in a
  repository is removed with no refusal and no `force`. Against "no loss of work product".
- `packages/domain/src/workbench/organization.ts:141` with `engine.ts:10893`: `canUseLink` checks
  only that the owner sees both projects. A private sibling added to a session in a shared project
  rides that project's worktree captures, `.git` and history included; any member who starts a
  session in that worktree materialises it. Decision 14 hides only the metadata.
- `packages/sessions/src/engine.ts:10945-10972`: the worktree is created before the row; when the
  row insert then fails (`(session_id, name)` taken by a racing add), the answer is `name-taken` and
  the new worktree, branch and capture 0 stay in the target project with no session and no row.
- `packages/sessions/src/engine.ts:10813-10862`: a failed add keeps its row and its worktree, so the
  same `mend repo add <project>` can never be retried as typed; there is no remove verb. The message
  does not say to use `--as` and `--worktree`.
- `apps/api/src/routes/worktrees.ts:257`: removing a sibling worktree cascades the
  `session_repositories` row, so the holder no longer relinks it, while its files stay at
  `.mend/repos/<name>` in the holder's captures. A later add of the same name then fails exit 65.
  Nothing tells the person the files are still there.
- `packages/sessions/src/engine.ts:9372-9376`: the note says `mend repo add <project>` puts it at
  `/workspace/repos/<project>`; the name is the project name only when it matches `REPOSITORY_NAME`.
  It also says "Commits there are that repository's own change", which Mend cannot show in the
  interim.
- Stale ADR pointers: about thirty code comments say `docs/adr/0010` for repositories (secret files
  is 0010), e.g. `packages/db/src/migrations.ts:2874`, `packages/sessions/src/engine.ts:10757`,
  `apps/api/src/routes/workbench.ts:2331`, `apps/web/src/lib/api.ts:71`; sealantd
  `docs/adr/0016-repository-roots.md:3` says "Mend ADR 0010". mend#482 said it fixed four.
- `docs/adr/0011-repositories-in-a-session.md:3`: status still "proposed" though it shipped.
