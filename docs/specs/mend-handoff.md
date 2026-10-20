# `mend handoff`

- **Release:** 0.36
- **Status:** designed. The shared types and the HTTP contract are in review on `handoff/2-server`;
  the server and the CLI are not built.
- **PRs:** stacked as `handoff/1-vocabulary`, `handoff/2-server`, `handoff/3-cli`.
- **Decision records:** none. Yiannis's decisions are listed below with their dates.
- **Written:** 2026-10-18, against mend main `ed9f782aa`.

## Why it exists

A person works on a branch in their own checkout and wants an agent, or themselves on another
device, to carry on from exactly that state in Mend. Before this feature the only way in was to push
the branch to origin and start a session on it. That loses the uncommitted and untracked files, and
it publishes work the person may not want on origin yet.

## What it does

From inside a checkout, `mend handoff ["prompt"]` copies the branch as it is into a new Mend
session. What travels is the commits ahead of the merge base with the default branch, the staged
files, the unstaged files and the untracked files. The checkout stays byte-identical. Review shows
exactly the local diff. Without a prompt, Mend holds a workspace with no agent.

```
$ mend handoff "finish the tests"
✓ project newsroom-api · main · from origin
✓ fix/login · 2 commits ahead of main · 3 uncommitted files · 1 untracked
  stays here · gitignored files and .env files: .env.local
  left out · assets/demo.mov · 212 MiB, over the 8 MiB file limit
  bundling 2 commits · 4 files → uploading 1.2 MiB → creating worktree
✓ handed off as fix-login · your checkout is unchanged · as of 10:42:05
  base main 3e73da3 · session 3f2a1c0d
✓ running · claude on your prompt
  attach · mend attach 3f2a1c0d
  watch · http://localhost:3105/sessions/3f2a1c0d
```

Without a prompt, the last block reads `✓ held · idle, no agent`, and the session row reads
`idle · handed off from dana-mbp`. A detached HEAD reads `✓ detached at 9c1e2f3 · …`, and the
worktree is named `handoff-9c1e2f3`.

When the checkout's repository is not adopted, the CLI asks
`adopt github.com/acme/newsroom-api as newsroom-api and hand off? [y/N]`. `--yes` answers yes.
Without a terminal and without `--yes`, it refuses with
`non-interactive · pass --yes to adopt … and hand off · nothing was created`.

Flags are `--with <harness>` (default `claude`), `--project <name>` and `--yes`.

### Decisions

Yiannis decided these. Do not reopen them.

- 2026-10-17. Handoff copies and never touches the local checkout. No index write, no ref write, no
  stash, and no file touched.
- 2026-10-17. Gitignored files and `.env*` files do not travel, and the CLI says so.
- 2026-10-17. Review shows exactly the local diff. The change's base is the merge base of the branch
  with the project's default branch.
- 2026-10-17. The fact line reads like
  `2 commits ahead of main · 3 uncommitted files · 1 untracked`, and the session row reads
  `idle · handed off from dana-mbp`.
- 2026-10-17. Edge cases. A checkout that is not adopted gets an offer to adopt. A detached HEAD
  works. A foreign origin is refused. Files over the limit are named and left out. An old server
  gets a plain error.
- 2026-10-17. The CLI comes first. VS Code comes with the extension rebuild.
- 2026-10-17. No prompt means a workspace held for the person, with no agent.
- 2026-10-18. The upload is one git bundle in the raw request body.
- 2026-10-18. "Handoff" means only this feature. The end-of-session summary the plan once called a
  handoff is a session summary, and switching a session between protocol and PTY mode is a mode
  switch. The mode switch keeps its wire names (`POST /sessions/:id/handoff`, `HandoffRequest`,
  `HandoffUnsupported`), because released CLIs call them.
- 2026-10-18. A second `mend handoff` of the same branch is a new handoff with a new worktree name,
  `fix-login-2`. The CLI says `handed off as fix-login-2 · fix-login is your earlier handoff`.
- 2026-10-18. A `.env*` file committed in a commit ahead travels with its commit, and the CLI names
  it: `travels in a commit · .env.local (1a2b3c4)`. The CLI walks every commit in `M..HEAD`,
  intermediate ones included, so a file added and later deleted is still named.
- 2026-10-18. The per-file limit is 8 MiB, set by `MEND_BUDGET_HANDOFF_FILE_BYTES`.
- 2026-10-18. With a prompt, the CLI launches the session and returns without attaching.

## How it works

### The snapshot is three commits with one tip

The client builds two commits in a scratch repository. `I` is a commit whose tree is the index and
whose parent is HEAD. `W` is a commit whose tree is the working tree and whose parent is `I`. The
chain is linear, so the one tip `W` reaches every object, index-only blobs included, and `W`'s sha
identifies the whole state.

`W`'s message is the subject `mend handoff`, a blank line, and these trailers in this order:

| Trailer            | Value                                                       |
| ------------------ | ----------------------------------------------------------- |
| `Mend-Machine`     | the machine's name, printable, 1 to 64 characters           |
| `Mend-Branch`      | the local branch; absent when HEAD is detached              |
| `Mend-Cut-At`      | the cut time, as `Date.prototype.toISOString` writes it     |
| `Mend-Default-Tip` | the client's `origin/<default>` sha, 40 or 64 lowercase hex |

Author and committer are `mend`, dated at the cut. The bundle has one ref,
`refs/mend/handoff/snapshot`, pointing at `W`, and is cut at `^M`, where `M` is the merge base. The
facts travel in the content, so the request needs no query string for them and the server needs no
cross-check. `formatHandoffMessage` and `parseHandoffMessage` in
`packages/domain/src/workbench/handoff.ts` own the message format.

`W` is unique per invocation because the cut time is in it. A retry of the same bytes converges on
one session.

### Client

The client lives in `apps/cli/src/handoff-snapshot.ts` and `apps/cli/src/handoff.ts`.

"Byte-identical" covers every file under the work tree (tracked, untracked and ignored) and under
the git dir and common dir: the index, `sharedindex.*`, HEAD, refs, packed-refs, logs, objects,
config and hooks. It covers bytes, mode, size and mtime, and no new file appears, a lock included.
atime is outside the promise. The procedure:

1. Drop every `GIT_*` variable, which also drops `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`. Set
   `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`. Every call gets
   `-c core.fsmonitor=false -c core.splitIndex=false -c core.untrackedCache=false -c gc.auto=0 -c core.hooksPath=/dev/null`.
   Every configured `filter.<name>` gets `clean=` and `process=` emptied and `required=false`, so no
   clean filter ever runs.
2. A shadow git dir holds byte copies of HEAD, `index`, `sharedindex.*` and `config.worktree`.
   `GIT_COMMON_DIR` points at the real common dir. Git only reads, refreshes or locks the copies.
3. Two environments work over a scratch bare repository. Reads see the checkout's objects as an
   alternate. Writes see only the scratch objects (`write-tree --missing-ok`,
   `hash-object -t commit`), so git freshens no object of the checkout.
4. Status comes from the copy (`--porcelain=v2 -z --untracked-files=all --no-renames`). Unmerged
   entries refuse.
5. Some files are left out. Each is pinned to HEAD's entry in both trees, or absent when HEAD has
   none, and named with a reason. They are `.env*` basenames (`isEnvPath`), blobs over the file
   limit in the index or the working copy, and paths with a `filter` attribute (`check-attr` over
   `ls-files` output, which runs no filter). Review then shows no change for them, never a deletion.
6. The ref and `bundle create <file> refs/mend/handoff/snapshot ^M` live in the scratch repository.
   The bundle goes to a file, never to stdout.

The project comes from `matchProjectByCwd`. The checkout's actual `origin` remote must then equal
the project's origin through `normalizeRemoteUrl`. Neither the directory-name fallback nor
`--project` bypasses that check, so a foreign origin is refused. When nothing matches, the CLI
offers to adopt `origin` (`confirmPlan`, `askYesNo`). `M` is
`merge-base HEAD refs/remotes/origin/<default>`. The CLI never fetches.

The worktree name is `handoffWorktreeName`. It slugs the branch (`fix/login` becomes `fix-login`) to
a valid `WorktreeName` that is also a valid git ref component under `mend/`. A detached HEAD, or a
branch with nothing left after slugging, is `handoff-<head7>`. A taken name gets `-2`, `-3` and so
on, within 64 characters.

The CLI talks to the server in this order:

1. `GET /projects/:id/handoffs`, through the raw GET (`download()`), before building anything. A 200
   answers `HandoffTerms {bundleBytes, fileBytes}`. A 404 with no JSON `_tag` is an old server, and
   the CLI says
   `this Mend server (0.35.1) does not take handoffs · upgrade it, then hand off again · nothing was created`.
   A `HandoffRefused` (co-located store, unsupported repository) prints the server's words.
2. The CLI checks the bundle against `bundleBytes` before upload.
3. `POST /projects/:id/handoffs` through a new raw-body helper beside `download()`. A connection
   that ends without an answer is retried twice with the same bytes.
4. With a prompt, `POST /sessions/:id/launch {prompt}`. The CLI returns without attaching.

The fact line (`formatFactLine`) counts commits in `M..HEAD`. Uncommitted files are tracked paths
that differ HEAD to index or index to working tree and that travel, each counted once. Untracked
files are untracked, not ignored, and travel. Zero commits read `even with main`, zero uncommitted
files read `no uncommitted files`, and `· N untracked` appears only when N is more than 0. A
checkout with nothing ahead and nothing uncommitted still hands off, as a held workspace at HEAD.

### Server

**Budget.** `request-budgets.ts` replaces `UPLOAD_ROUTES` and its two-way ternary with one table,
`BODY_ROUTES: [method, path, budget]`. The handoff row names `bundleBytes`. `budgets.ts` gains
`handoffFileBytes` (8 MiB, `MEND_BUDGET_HANDOFF_FILE_BYTES`). The ingress docs move from
`proxy-body-size: 32m` to `72m`.

**Contract.** `packages/api-contracts/src/handoffs.ts` defines the `handoffs` group:

- `GET /projects/:id/handoffs` answers `HandoffTerms {bundleBytes, fileBytes}`. Errors are
  `NotFound` and `HandoffRefused`.
- `POST /projects/:id/handoffs?harness=&hold=` takes `HandoffBundleBytes`
  (`application/x-git-bundle`) and answers
  `HandoffReceived {session, worktree, commitsAhead, replayed}`. Errors are `NotFound` (404),
  `HandoffRefused` (422, `{reason, message}`), `BudgetExceeded` (429) and `StoreFailure`.
- `HandoffRefused.reason` is one of `store-co-located`, `unsupported-repository`, `not-a-handoff`,
  `damaged`, `base-unknown` and `base-off-default-branch`.

**Admission.** `Store.admitHandoff` in `packages/store/src/handoff.ts` is the only constructor of
the branded `AdmittedHandoff` (a unique-symbol brand, not a private constructor). It works in a
quarantine bare repository on the store's filesystem whose alternates are the store's objects, in
this order:

1. A pure header parse. The bundle must have one ref and one prerequisite.
2. `bundle verify`. A missing prerequisite triggers one `freshenBase(default)`, then refuses
   `base-unknown`.
3. `fetch -c fetch.fsckObjects=true`, then `rev-list --objects --missing=error`.
4. The shape. `W^` is `I` and `I^` is `H`.
5. The trailers, through `parseHandoffMessage`.
6. The merge base, recomputed. `merge-base H <Default-Tip>` must equal `M`, and `Default-Tip` must
   be in the store's `origin/<default>` history. The store resolves those shas and passes them in,
   because the quarantine has objects and no refs.
7. The delta pack, `pack-objects --revs W ^M` (not thin), built from the quarantine.

Content rejections are `damaged`. Host failures are `StoreFailure`. A refusal writes nothing of the
handoff. The only store write on any path is the origin freshen, which is ordinary store behaviour.
Nothing is fetched into the bare store, so there are no anchor refs to keep and none to sweep.

**One creation path.** `WorktreeStart = Base{base: string | null} | Handoff{admitted}` replaces
`base` in `ProvisionInput`, `ensureWorktreeIn`, `createWorktreeIn` and
`SessionRepository.createWorktree`. Every existing caller passes `Base`. A handoff never joins an
existing worktree. Captured `createWorktree(Handoff)` uploads the delta pack (content-addressed,
`recordPacks`), inserts `refs/heads/mend/<name>` at `H`, and returns `baseSha = M` and
`baseRef = project.defaultBranch`. The branch ref insert is create-only, so it must start at `H`.
Inserting it at the base and moving it later would silently leave it at the base. An existing ref
already at `H` is a crash replay. The co-located adapter refuses.

**Provenance, replay key and seed in one place.** Migration 0135 adds `worktrees.handoff jsonb`,
nullable and decoded by `WorktreeHandoff`:
`{machine, localBranch, cutAt, head, index, checkpoint, mergeBase, deltaPack}`. A unique index
covers `(project_id, (handoff->>'checkpoint'))`. The column rides the `ExactKeys` seam, `Worktree`
and its DTOs. `worktreesRepo.create` writes it in the same insert as the row. It is the replay key,
the provenance and the capture-0 seed.

**Capture 0.** `attachWorktree` derives `captureZeroSource(row)`:

- branch `H`, and checkpoint 0 is `W`;
- `WORKTREE_TREE_REF` is `W^{tree}` and `INDEX_TREE_REF` is `I^{tree}`;
- packs `[uploadBasePack(M), deltaPack]`;
- `refs/mend/base/<wt>` is `M`;
- `fsck: verified`, which admission earned.

Base and legacy worktrees fold into the same function. `ensureForWorktree(M)` makes review the
worktree tree minus `M`. Capture 0 exists before `provisionInWorktree`, so a hot claim keeps it.
`capture-verify.ts` walks the listed packs together, so a multi-pack capture 0 verifies.

**Engine verb.** `SessionStart.handoffAs(caller, projectId, query, bytes)` runs:

1. access;
2. co-located store or unsupported repository refusals;
3. the replay lookup by `W`. A replay returns the worktree and its first session, provisions a
   session if there is none, and re-applies the hold. It runs before the session budget;
4. `requireSessionRoom`;
5. `admitHandoff`;
6. `engine.provision({start: Handoff})`;
7. the audit event `worktree.handed_off`;
8. with `hold`, `resumeSession(id, "shell")`, forked past the answer. This is the VS Code
   held-workspace pattern on the server side, so a client that dies cannot strand `launching`.

**Rows.** `handed off from <machine>` is a fact of the worktree and shows on every session line in
it. The CLI shows it in `sessionRowFacts` (`idle · handed off from dana-mbp · claude · 1 shell`) and
`WorktreeRow`. The web shows it in `SessionLine`, `WorktreeFactLine` and the Now card.

### Crashes

| Crash after       | Residue                          | Repair                                                                           |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| admission         | quarantine dir                   | `ensuring` removes it; boot removes `handoff-q-*` older than 1 h                 |
| delta pack upload | an unreferenced recorded pack    | the retry re-puts the same key; capture retention owns bucket cleanup            |
| branch ref        | `store_refs` branch at H, no row | the retry accepts a ref already at H                                             |
| row               | worktree with seed, no capture 0 | replay, or the next launch's `ensureCaptureZero`, builds capture 0 from the seed |
| capture 0         | worktree, no session             | replay provisions the session                                                    |
| session           | `starting`                       | replay re-applies the hold; otherwise `mend attach` resumes it                   |

## Known limits

- A server crash between provisioning and the hold leaves a `starting` session. `mend attach` or the
  CLI's retry recovers it. There is no reconciler.
- The merge base is the client's, recomputed and checked against its default tip. Review equals
  `git diff M`. A newer server main never moves it.
- `asUint8Array` buffers the whole body (up to `bundleBytes`) after auth, in exchange for a typed
  payload.
- Install detection still reads `session.baseSha`, so a lockfile added on the branch is not seen
  until the first install. This is a follow-up.

These alternatives were weighed and not taken, so a reviewer should not report their absence.

- Receipts with tombstones, a durable opening outbox and a reconciler.
- A transactional rewrite of worktree publication.
- Streaming the body through `handleRaw`.
- An `Idempotency-Key` with saved retry material.
- Refusing intent-to-add, skip-worktree or sparse checkouts, or split indexes.
- A metadata commit carrying the prompt.
- Reading the POST's 413 instead of asking for the terms first.
- Running git against the real `GIT_DIR` with a scrubbed environment.
- Writing the bundle header by hand.

## How to verify

Each PR in the stack is green on `pnpm exec turbo typecheck --force` and
`pnpm exec turbo lint --force`, plus its own check.

1. `handoff/1-vocabulary`. The session summary and mode switch words and identifiers. The mode
   switch wire stays pinned.
2. `handoff/2-server`. The domain types, `Store.admitHandoff`, `WorktreeStart` through the engine
   and the port, migration 0135, captured capture 0, the budgets table, the contract, the routes,
   the hold and provenance on the DTOs. Checks:
   - fixture-repository tests, where each refusal leaves store refs and objects unchanged;
   - an engine test covering manifest refs and trees, packs that close, change base `M`, `baseRef`
     main, one session on replay, and a hot claim that keeps capture 0;
   - HTTP tests through the real middleware covering the 64 MiB route, the other upload routes still
     at 24 MiB, and the old 1 MiB elsewhere.
3. `handoff/3-cli`. The snapshot, the command, the upload helper, the catalog, the flag-gate
   `READS`, completions, the README, `reference/cli.md`, a guide, a changeset, rows in the CLI and
   web, and `.claude/skills/verify/features/handoff.md`. Checks:
   - snapshot fingerprint tests on real repositories (hostile environment, split index, detached
     HEAD, linked worktree, filters);
   - fake-server command tests for every copy line;
   - the live verify run. The checkout's fingerprint is identical before and after. The row reads
     `idle · handed off from <host>`. The review base is `main <M>`, with exactly `git diff M` plus
     untracked files minus those left out. The staged and unstaged split holds inside the session.

## Divergences found while writing

None. The server and the CLI are not built yet.
