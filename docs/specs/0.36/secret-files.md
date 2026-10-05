# Secret files

- **Release:** 0.36
- **Status:** on main (mend#478 merged as `d58ace91a`; the opencode set-aside from mend#503 merged
  as `3d098b0f9`). Per-person delivery (a joiner receives their own set, five mapped paths) is
  designed in mend#534 (ADR 0016 §7, open), not built. This spec describes main; ADR 0016's target
  is marked where it differs.
- **PRs:** mend#478 (secret files, migration 0101), mend#503 (`.local/state/opencode` reserved,
  files there set aside), mend#513 (launch file execs; secret files keep their own writer), mend#534
  (ADR 0016, open).
- **Decision records:** docs/adr/0010-secret-files.md (decisions 1-6, decision log of 2026-10-03);
  docs/adr/0016-per-person-harness-homes.md §7 (mend#534, open).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec426e`, sealantd main
  `07ada506a`.

## Why it exists

The owner develops Mend inside Mend on the box. A session there needs files that are neither code
nor environment: `~/.aws/credentials`, `~/.aws/config`, a kubeconfig, an `.npmrc` token file. Mend
carried project secrets (environment variables, per project) and dotfiles (a plain tree applied at
boot, which the guide says to keep secrets out of). Nothing carried a secret file sealed at rest,
per person, kept out of every capture. Every person who needs a tool that reads a credential file
hits it at every session; the workaround was pasting the file into each session by hand, or putting
it in dotfiles, unsealed and possibly committed. Owner decisions of 2026-10-03: the noun, per
person, never captured, shared with no one, the project secrets' posture.

## What it does

- A person keeps a file in Mend with a path under the workspace home and its content.
- Every session they own, in every project, receives their files before its agent starts, 0600 in
  directories made 0700 when missing.
- The content never comes back out of the server; lists show path, size, revision and dates.
- A running session keeps the files it has until its next run in the same workspace, which receives
  the files added or replaced since and no longer has the ones removed.
- A session that joins a worktree another person's live session holds (capture mode) runs in that
  person's executor and receives none of its owner's files there.

Surfaces:

- CLI (`apps/cli/src/main.ts:2550-2605`, `apps/cli/src/secret-files.ts`):
  - `mend secrets` (or `mend secrets list`):
    `~/<path>  <size>  <yyyy-mm-dd hh:mm>[ · replaced N times]`; none:
    `no secret files · mend secrets add <path> --from <file> keeps one`.
  - `mend secrets add <path> [--from <file>]`, content from stdin without `--from`. `~/x`, `x` and
    an absolute path under this machine's home all name `x`; any other absolute path is refused.
    Prints `created ~/<path> · <n> B · sessions launched from now on receive it` or `replaced …`.
    Empty input: `nothing on stdin` or `<file> is empty`.
  - `mend secrets rm <path>`: `removed ~/<path> · sessions launched from now on do not receive it`
    or `~/<path>: not kept`.
- Web, Settings → "Secret files" (`apps/web/src/components/secret-files-panel.tsx`): list with
  Remove, add by path plus a chosen file or pasted text; footer
  `<n> kept · up to 64 · each at most 256 KB`.
- Phone, Settings: the list only (`apps/mobile/src/data/secret-files.ts`).
- Desktop, VS Code, Slack, t3 gateway: none.

Limits (`packages/domain/src/workbench/secret-file.ts:24-27`): 256 KB per file, 1 byte minimum, 64
files, 1 MB in all, paths up to 512 characters. Session line on refusal:
`secret files · <n> not written · ~/<path> · <reason> · …`.

**In scope.**

- Storage, sealing, validation and the three API routes.
- Delivery at every launch the person owns (cold, claimed standby, run in a retained executor that
  is their own).
- The proof that a path is still a plain path in the home before every write.
- The sealed delivery record and removal of files the person no longer keeps.
- Refusal of paths under directories sessions capture; the co-located harvest and transcript read
  following no link.
- The set-aside of files at paths reserved after delivery (`.local/state/opencode`, mend#503).

**Out of scope.**

- Project-level secret files (a later change, ADR 0010 "Considered").
- A platform launch-time file injection; bytes ride exec argv until Core offers one
  (PLATFORM-FEEDBACK 2026-10-03).
- Keeping anything running in the workspace from copying the file elsewhere: the agent, a dependency
  install or a setup recipe can read it and write it into the worktree, which is captured.
- Secret files for a joiner on main (ADR 0016 changes this).
- Recovering files after a lost `secrets.key`: enter them again.

## How it works

### Storage and API

- `user_secret_files` (migration 0101, `packages/db/src/migrations.ts:2815-2832`): `id`, `user_id`
  (cascade), `path`, `sealed_contents`, `bytes`, `revision` (starts 1, +1 per replace),
  `created_at`, `updated_at`; unique `(user_id, path)`.
- `PUT /me/secret-files` (`apps/api/src/routes/secret-files.ts:30-49`): `validateSecretFilePath`,
  `validateSecretFileContent` (valid base64, not empty, ≤ 256 KB), then `SecretCipher.encrypt` of
  the bytes as base64 (AES-256-GCM under the server's `secrets.key`, the project secrets' cipher).
  422 `SecretFileRejected` with the rule's message. Returns `{file, action: created|replaced}`.
- `SecretFilesRepo.save` (`packages/db/src/repos/secret-files.ts:100-166`): path validation again,
  `bytes` an integer in 1..256 KB, per-user advisory lock, count ≤ 64 for a new path, total ≤ 1 MB.
- `GET /me/secret-files`: path, name, bytes, revision, dates. `DELETE /me/secret-files?path=`:
  `{removed}`; the path is not validated, so a row at a path reserved since can still be removed.
- No route takes another person's id; every handler uses `CurrentUser`.

### Paths

`validateSecretFilePath` (`secret-file.ts:93-132`): non-empty, ≤ 512 chars, not starting with `/` or
`~`, no backslash or control character (tab included), no empty, `.` or `..` segment, and not equal
to or under `SECRET_FILE_RESERVED_PATHS` (`:35-43`): `.claude`, `.claude.json`, `.codex`, `.pi`,
`.local/share/opencode`, `.local/state/opencode`, `.mend`. Message:
`<path> is under <root>, which sessions capture`.
`packages/sessions/src/secret-files.test.ts:519-545` holds the list against every `HARNESS_STATE`
home dir and harvested path.

### Launch, cold or claimed standby

`launchInternalBody` (`packages/sessions/src/engine.ts:11840-11913`):

1. `evictReservedSecretFiles` (`engine.ts:10153-10220`) before the relocation. Failure: capture mode
   abandons the executor; the launch fails with code `secret_files_not_set_aside` ("a secret file
   under a directory sessions now save could not be taken out of it (…); the harness home was not
   moved, so nothing of it is saved", `engine.ts:479-485`). A fresh executor has no record, so this
   is a no-op there.
2. Relocation, skills, memory hand-over and delivery, Codex carry and withholding, pi profile.
3. `deliverSecretFiles(session, workspace)` (`engine.ts:10231-10351`). Any error: warning plus
   session line `secret files · not written · <message>`; the launch continues.
4. Repositories, workspace note, dependency install (capture mode), harness start.

### Retained launch (resume, follow-up, mode handoff, join)

`launchInRetainedWorkspace` (`engine.ts:12636-12685`): `evictReservedSecretFiles` before relocation
(failure settles the session failed, `resume failed: …`); then delivery only when
`workspaceOverride === null || executorOwnerUserId === session.ownerUserId`. A join passes the lease
holder's workspace and owner (`engine.ts:11272-11290`); another person's executor logs
`secret files not written · the executor is another person's` and writes nothing.

### Delivery

`deliverSecretFiles`:

1. Reads `~/.mend/secret-files` (`secretFilesDeliveredExec`, `secret-files.ts:320-325`; prints
   nothing when `~/.mend` or the record is a link). Decrypts with the machine key and decodes it
   only when it names this workspace id (`decodeSecretFilesRecord`, `:228-252`); otherwise it is
   ignored with the warning `secret files · the home's record is not this workspace's, ignored`.
2. Nothing stored and nothing recorded: done.
3. Unseals every stored file (one failure fails the delivery, named by path only:
   `~/<path> could not be unsealed with this machine's key`). `planSecretFiles` (`:134-148`) refuses
   a stored path that no longer validates.
4. `secretFilesExecs(files, stamp)` (`:156-187`), stamp = 16 hex chars per delivery: files whose
   base64 fits `WORKSPACE_EXEC_ARG_CHARS` (90,000) are batched into `sh -c` execs; larger ones go as
   a first chunk, next chunks and a finish exec. Each step runs `secret_target` (`:72-78`):
   - `H` = `cd $HOME && pwd -P`; refused when `H` is `/workspace` or under it;
   - no component of the path is a symlink; the target is absent or a regular file;
   - the directory is made with `umask 077` and must equal its physical path.

   Staging file `<target>.mend-secret-part-<stamp>`, `umask 077`, `base64 -d`; a next chunk appends
   only to an existing regular non-link staging file; finish `chmod 600` and `mv -f` over the
   target. Outcomes on stdout, tab-separated: `written`, `refused\t<path>\t<reason>`.

5. On any failed exec or interruption, `secretFilesCleanupExec` (`:195-205`) removes this stamp's
   staging files, proving each path first and never removing through a link.
6. Paths in the record that are no longer stored go to `secretFilesRemoveExec` (`:261-274`): removed
   only when the file is on a plain path and its SHA-256 equals the recorded one; else `kept`.
7. The new record (written files with their digest, files refused this time but recorded before,
   stale files whose removal was refused) is sealed and written to `~/.mend/secret-files` 0600
   through `secretFilesRecordExec` (`:332-341`), or removed when empty; nothing is done when
   `~/.mend` or the record is a link.
8. Each outcome is logged by path (`session engine: secret file · written|removed|kept`,
   `· not written` with reason); refusals go to the session line (`secretFilesRefusedWords`,
   `engine.ts:874-878`).

### Never captured

- By construction: `$HOME` is `/root` on the executor's own disk. sealantd captures only
  `/workspace/repo` (`tree/`) and `/workspace/harness-home` (`harness/`).
- By refusal at save: reserved paths (above).
- By refusal at write: `secret_target` (above).
- By refusal at harvest: the co-located harvest (`harvestHarnessStateScript`,
  `packages/sessions/src/harness-state.ts:380-396`) and transcript read (`readHarnessFileScript`,
  `:403-407`) take only the relocation's own top-level link (`physical_root`, `:358-363`); `tar`
  follows no link. sealantd stores a link as a link.

### Paths reserved after delivery (mend#503)

`.local/state/opencode` became a captured directory on 2026-10-04. `evictReservedSecretFiles` reads
the home's record (an unreadable or undecryptable record fails the launch); recorded paths now under
a reserved root go to `secretFilesSetAsideExec` (`secret-files.ts:291-314`):

- nothing there: `absent`;
- a regular file on a plain path with the recorded SHA-256: `rm -f`, `removed`;
- anything else (edited bytes, reached through a linked directory, a link, a directory): `mv -f` to
  `~/.mend/secret-files-set-aside/<stamp>/<path>`, made with `umask 077` and proven to be physically
  where its name says, `moved\t<path>\t~/.mend/secret-files-set-aside/<stamp>/<path>`;
- the home inside `/workspace`, a set-aside directory that resolves elsewhere, or a move that leaves
  anything at the path: `failed\t<path>\t<reason>`, exit 1.

The record drops every `removed`, `absent` or `moved` path. Each `moved` one is logged and put on
the session line:
`secret file ~/<path> · under a directory sessions now save · moved to ~/.mend/secret-files-set-aside/<stamp>/<path>`.
Any `failed`, or a path left: the relocation does not run.

### Under ADR 0016 (designed)

Each person's set is written into their own home `/root/.mend/homes/<account>` at each of their
process starts, joins included. `.aws/credentials`, `.aws/config`, `.kube/config`, `.npmrc` and
`.docker/` get `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `KUBECONFIG`,
`NPM_CONFIG_USERCONFIG`, `DOCKER_CONFIG` pointing at the person's copy, whether or not they have
one. Files under `.config/`, `.local/share/`, `.local/state/`, `.cache/` sit where the person's
tools read them. Any other path (`~/.ssh/…`, `~/.netrc`) is also written to `/root` for the person
whose launch made the executor only; a joiner's are named on the session line as not written.
Reserved paths grow by `.mend/homes` and `.mend/logins` (already under `.mend`).

## Happy path

Anna, project `infra`, capture mode.

1. On her laptop: `mend secrets add ~/.aws/credentials --from ~/.aws/credentials`. Output:
   `created ~/.aws/credentials · 116 B · sessions launched from now on receive it`.
2. `mend secrets`: `~/.aws/credentials       116 B  2026-10-05 09:12`.
3. `mend secrets add .claude/settings.json --from x`: refused,
   `.claude/settings.json is under .claude, which sessions capture`.
4. `mend claude --name deploy`. Server log: `session engine: secret file · written`, path
   `~/.aws/credentials`. In `mend shell <id>`: `ls -l ~/.aws/credentials` shows `-rw-------`,
   `stat -c %a ~/.aws` shows `700`; `cat ~/.mend/secret-files` prints sealed text, not JSON.
5. Anna stops the session and its executor ends. Its captures list `tree/` and `harness/` only;
   nothing under `~/.aws` is in them.
6. `mend claude --worktree deploy -d` (session `<s>`, a fresh executor, the file written again),
   then `mend shell <s>`. In the web app, Settings → Secret files, she replaces the file by choosing
   a new one; the row reads `replaced 1×`. The shell still shows the old file. She stops the agent
   (`mend stop <s>`); the open shell keeps the executor. `mend resume <s>` runs in the retained
   executor and writes the new file.
7. `mend secrets rm .aws/credentials`, then `mend stop <s>` and `mend resume <s>` again: the
   retained run removes `~/.aws/credentials` while it still holds the bytes Mend wrote; the log says
   `secret file · removed`.
8. Maria joins Anna's worktree `deploy` (`mend claude --worktree deploy`) while Anna's session runs.
   Maria's own secret files are not written; the server log says
   `secret files not written · the executor is another person's`.

## Invariants

1. No API response carries a secret file's content, in any encoding, to anyone.
2. No route reads, writes or lists another person's secret files.
3. A secret file is never written under `/workspace` or through a symlink at any component of its
   path; the written file is 0600 and a directory Mend creates for it is 0700.
4. No capture, checkpoint, change, co-located harvest archive or transcript read carries a secret
   file's bytes as a result of anything Mend does.
5. One person's secret file is never written into a home another person's agent runs in (ADR 0010
   decision 3, decision log "a join … receives no secret files there").
6. A delivery never leaves a half-written file at a target; a delivery cut short leaves no staging
   file of its stamp on a plain path.
7. Mend removes a file in a workspace only when its own sealed, workspace-bound record names it and
   the file still holds the recorded bytes on a plain path; anything else is kept or moved aside,
   never deleted.
8. A secret file at a path that became reserved is out of that directory before the relocation runs,
   or the launch does not start.
9. Server logs and session lines name paths and reasons, never content; an unseal failure names the
   path only.
10. A secret file's bytes exist in plaintext on the server only between unsealing and the exec that
    writes them, and in the workspace only at the target and its staging file.

## Edge cases and failure behaviour

**Concurrent actions**

- Two deliveries into one home at once (two launches of the same person into one executor): each
  stages under its own stamp; each target is a whole file; the record is last writer wins (test "two
  deliveries into one home at once each leave a whole file").
- A replace while a session runs: the running session keeps its file; the next run in the same
  executor gets the new one.
- Save and remove racing: serialised per person by the advisory lock.

**Restarts**

- Mend restart mid-delivery: the exec in flight finishes or not; staging under that stamp may remain
  (cleanup runs on interruption only while the server lives). It is on the executor's disk, outside
  every capture, and a later delivery's `rm -f "$P"` only touches its own stamp.
- Executor replaced: a fresh executor has no secret files and no record; the next launch writes
  them.
- A rotated or lost `secrets.key`: unsealing fails,
  `secret files · not written · ~/<path> could not be unsealed with this machine's key`; a retained
  executor's record no longer unseals, so the eviction step fails and every launch or resume into
  that executor is refused with `secret_files_not_set_aside` (`the home's record does not unseal`).
  Delivery itself ignores such a record.

**Partial failures**

- One file refused (symlinked directory, not a regular file, directory cannot be made): the others
  are written; session line lists the refused one.
- An exec fails: the delivery stops, cleanup runs, warning and session line
  `secret files · not written · exit <n>: …`; the agent still starts.
- The new record cannot be sealed: it is removed (see Divergences).

**Odd input**

- Paths with spaces, quotes, a leading dash: taken as they are.
- A path whose base64 exceeds 90,000 chars (> ~66 KB): chunked; a directory turned into a link
  between chunks takes no later chunk and no rename.
- `.aws` saved as a file and `.aws/credentials` as another: both accepted; the second is refused at
  write (`could not make its directory`).
- A path a dotfiles tree made a symlink (`~/.npmrc -> dotfiles/.npmrc`): refused,
  `a symlink is at that path`.
- A dotfiles-provided plain file at the same path: replaced by the secret file at every delivery.
- An edit the session made to a delivered file in a retained executor: overwritten at the next run
  there; not captured, so the edit is not kept anywhere.
- A forged plain-JSON `~/.mend/secret-files`: does not unseal, ignored by delivery, fails eviction.

**Older data**

- A file delivered at `.local/state/opencode/…` before 2026-10-04 in a still-running executor:
  removed or moved aside before the next relocation into it; the stored row is refused at delivery
  (`is under .local/state/opencode, which sessions capture`) until the person removes it.
- A record from before a path was reserved still decodes (`validateSecretFilePathSyntax`).

**Permissions**

- Owner of the session: receives their files in their own executor.
- Joiner (capture mode): receives none in another person's executor; their agent can read the
  holder's files (root).
- Steerer under shared control: the steered turn runs in the owner's workspace with the owner's
  files; the steerer's files are not involved.
- Operator: no access to anyone's files.
- Members: no route to another member's files.

**Clients**

- CLI: full. Web: list, add, remove. Phone: list. Desktop, VS Code, Slack, t3 gateway: none;
  sessions they start receive the owner's files through the engine.
- Web and phone query keys are not keyed by account; after a sign-out and sign-in as someone else on
  the same client, the previous account's paths can show until refetch (ADR 0010 decision log).

## Known limits

- A joiner receives no secret files in another person's executor; everyone in one executor can read
  every file there (ADR 0010 Consequences; ADR 0016 §10).
- Bytes cross the platform's exec as base64 argv for one exec (ADR 0010 decision 5;
  PLATFORM-FEEDBACK 2026-10-03).
- A lost `secrets.key` loses project secrets and secret files alike.
- Running sessions keep the files they have; a removed file goes from the next run on.
- Client caches keyed without the account (ADR 0010 decision log, 2026-10-03, second review).
- Anything in the workspace can copy a secret file into the worktree, which is captured.

## How to verify

**Tests**

- `packages/sessions/src/secret-files.test.ts`: writing (modes, quoting, replacing, chunking,
  concurrent deliveries, symlinked directories, a directory linked between chunks, cleanup, removal
  only of Mend's bytes, the sealed record), reserved paths against `HARNESS_STATE`, the set-aside
  (`:401-482`), a capture listing and co-located harvest that hold no secret file whatever links an
  agent left (`:599`), the transcript read (`:689`).
- `packages/db/test/secret-files.test.ts`; `apps/api/src/routes/secret-files.test.ts`;
  `apps/cli/src/secret-files.test.ts`; `apps/api/src/routes/project-access.test.ts` (route
  classification).
- `packages/sessions/test/engine.test.ts:21267-21300` ("refuses the launch, before the harness home
  moves, when the home's record of secret files cannot be read").
- Not covered: a retained run of a session that earlier joined another person's executor (see
  Divergences); a rotated key against a retained executor; an end-to-end box run.

**On the box**

```sh
printf '[default]\naws_access_key_id = AKIATEST\naws_secret_access_key = x\n' | mend secrets add .aws/credentials
mend secrets
mend claude --name sf -d          # session <s>
mend shell <s>                    # keep this shell open; it keeps the executor
ls -l ~/.aws/credentials; stat -c %a ~/.aws; head -c 40 ~/.mend/secret-files; echo
grep -r AKIATEST /workspace 2>/dev/null   # nothing
# from another terminal:
mend secrets rm .aws/credentials && mend stop <s> && mend resume <s>
ls ~/.aws/credentials             # in the shell: gone
```

**Signals** (server log): `session engine: secret file · written|removed|kept`, `· not written`,
`secret files not written · the executor is another person's`,
`secret files · the home's record is not this workspace's, ignored`,
`secret file ~/<path> · under a directory sessions now save · moved to …`; session line
`secret files · <n> not written · …`; launch failure code `secret_files_not_set_aside`.

## Divergences found while writing

1. `packages/sessions/src/engine.ts:12670-12672` with `:12288`, `:13027`, `:13138`, `:13246`: a
   retained run without `workspaceOverride` (resume, terminal follow-up, shell resume, mode handoff)
   counts the retained executor as the owner's home. A session that earlier joined another person's
   executor has that executor on its row (`setSealantIds`, `:12771-12775`), and
   `retainedWorkspaceAvailable` (`:12891-12915`) accepts it while any shell or Service lives there.
   Its owner's secret files are then written into the holder's home: the holder's agent can read
   them, a same-path file (`.aws/credentials`) replaces the holder's own, and the holder's files
   that the joiner does not keep are removed as stale by the joiner's delivery (the holder's record
   is bound to that workspace and decodes). Contradicts ADR 0010 decision 3 and invariant 5.
2. `packages/sessions/src/engine.ts:10326-10332`, `:10193-10199`: when sealing the new record fails,
   `orElseSucceed(null)` makes `secretFilesRecordExec(null)` remove the record. Files already
   written are then untracked, and a later removal by the person does not take them out of a
   retained executor.
3. `packages/sessions/src/engine.ts:12636-12644` (eviction in the retained path,
   `evictReservedSecretFiles` at `:10153-10220`) runs for a join too: it reads and acts on the
   holder's record and puts the holder's secret file paths and set-aside locations on the joiner's
   session line, and a failure settles the joiner's session (opencode review round 3 note). Paths
   only.
4. `packages/sessions/src/secret-files.ts:320-325`: a linked `~/.mend` makes the record read as
   absent, so eviction does nothing and the relocation proceeds (fail-open; needs something in the
   executor to replace `~/.mend` with a link after a delivery).
5. ADR 0010 decision 3 and the guide say the join refusal is in "the log" / "the session log"; on
   main it is a server log line only, nothing on the session line. ADR 0016 §7 says the session line
   names them.
6. `packages/db/src/repos/secret-files.ts:100-166`: no check that one stored path is not a prefix
   directory of another (`.aws` and `.aws/credentials`); the conflict surfaces only at write.
