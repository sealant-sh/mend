# Secret files: a person's credential files, written into every session, never captured

Status: proposed 2026-10-03. The owner's decisions of 2026-10-03 (the noun, per person, never
captured, shared with no one, the project secrets' posture) are taken as given here; the decisions
below are the ones this document adds.

Amended 2026-10-05 by [ADR 0016](0016-per-person-harness-homes.md) §11, amending decision 3 below:
each process's `HOME` is its person's own home in the executor (`/root/.mend/homes/<account id>`),
and each person's set is written there, a joiner's and a steerer's process included. Shared control
now changes which set a turn uses: a steered turn runs as the steerer, with the steerer's files.

## Context

The owner develops Mend inside Mend on the box, and a session there needs files that are neither
code nor environment: `~/.aws/credentials` and `~/.aws/config`, a kubeconfig, an `.npmrc` token
file. Mend carries two kinds of per-launch input today:

- **Project secrets** (migration 0026): environment variables, per project, sealed at rest with
  AES-256-GCM under the machine's `secrets.key` (`@mend/store` SecretCipher), names visible and
  values write-only, unsealed once per launch and handed to the platform's transient `secretEnv`.
- **Dotfiles**: a tree from a repository or a synced snapshot, per person, applied at boot as plain
  files. The guide tells people to keep secrets out of them.

Nothing carries a secret _file_. A dotfiles snapshot would, but as a plain file in a tree the
platform applies and the person's repository may hold.

### What a workspace captures

In capture mode (ADR 0002) sealantd ships the workspace class from two roots (`roots.rs`): the
worktree at `/workspace/repo` under `tree/`, and the harness home at `/workspace/harness-home` under
`harness/`, less the harness credential files sealantd#127 listed (`CREDENTIAL_FILES`:
`.claude/.credentials.json`, `.codex/auth.json`). The harness home relocation
(`relocateHarnessHomeScript`) turns `~/.claude`, `~/.codex`, `~/.pi`, `~/.local/share/opencode` and
`~/.local/state/opencode` into symlinks onto that root. The co-located harvest archives the
harness's state paths from `$HOME` with `tar -h`, dereferencing those links. The change and every
checkpoint read the worktree. Nothing reads the rest of `$HOME`, which is `/root` on the executor's
own disk.

### How Core writes a credential file

Core's connected accounts arrive as `credentialFiles` on the runtime adapter's launch input,
resolved by the worker from the account store, never by the caller: `docker exec -i … sh -c` with
the base64 content on stdin, `umask 077`, `chmod`, into `$HOME` before the workspace reports ready
(`writeCredentialFiles`, design doc §6). The SDK's `workspaces.create` has no field for a
caller-supplied file (PLATFORM-FEEDBACK.md, 2026-10-03). Its `exec` takes argv only, and Mend
already writes files through it after boot: skills, the pi profile and agent memory ride argv as
base64 (`workspace-files.ts`).

## Decision

1. **`secret file` is a product noun.** A file a person keeps in Mend, sealed at rest, with a path
   under `$HOME` in the workspace and its content. Per person, in every project. Shared with no one:
   no route names anyone else's, and shared control changes nothing, since the steered session is
   the owner's and runs in the owner's workspace.

2. **Same posture as project secrets.** The content is sealed with the same key and cipher
   (`SecretCipher`, `secrets.key`), as base64 so binary files round-trip, in `user_secret_files`
   (migration 0101), one row per path. The API returns path, size, revision and dates. No route
   returns content in any shape; replace and delete are the only writes after create. A file is at
   most 256 KB, and a person keeps at most 64, 1 MB in all.

3. **Written at every launch the person owns, before the harness starts,** in both stores through
   the platform's exec, after the harness home relocation and beside skills, pi profile and memory:
   the cold launch, the claimed standby, and a run started in a retained executor, which may predate
   a file added since. Only into a home that is the person's: in capture mode a worktree has one
   executor, and a session joining a worktree another person's session holds runs in that person's
   executor, so it receives no secret files of its own there, and the log says so (superseded by ADR
   0016 §7: a joiner receives their own set in their own home). The server unseals the set once per
   launch and holds the bytes only for that write. Each file lands 0600, its directory made 0700
   when missing, staged beside the target under the delivery's own stamp and renamed into place; a
   delivery cut short removes its staging files. What was written is recorded at
   `~/.mend/secret-files`, sealed with the machine key and bound to the workspace, each file with
   the digest of its bytes; the next delivery into that home removes a recorded file the person no
   longer keeps, only while it still holds those bytes, never through a link, and a record that does
   not unseal or is another workspace's says nothing. Best-effort like skills: an agent without its
   files still starts, and the session line says which were not written and why.

4. **Never captured, by construction and by refusal.**
   - By construction: a secret file goes into the executor's own `$HOME`, which no capture root,
     harvest, change or checkpoint reads (Context).
   - By refusal at save: a path equal to or under a directory the relocation moves onto the captured
     root, the one harness file the harvest takes from the home root, or Mend's markers
     (`SECRET_FILE_RESERVED_PATHS`: `.claude`, `.claude.json`, `.codex`, `.pi`,
     `.local/share/opencode`, `.local/state/opencode`, `.mend`) is refused with "which sessions
     capture". A test in `@mend/sessions` holds that list against `HARNESS_STATE`, so a harness
     added without extending it fails the build. `..`, absolute and `~` paths are refused too.
   - By refusal at write: the workspace proves the path is still a plain path in the home before
     writing: the home resolves outside `/workspace`, no component is a symlink, and the directory's
     physical path equals its literal one. Dotfiles that linked `~/.aws` into the worktree would
     otherwise make a secret file a captured one. Such a file is not written, and the session line
     says so.
   - By refusal at harvest: the co-located harvest archives the harness's state paths from where
     they physically are, under the mount the relocation linked them onto, with a `tar` that follows
     no link; the relocation's own links are the one indirection taken, and a directory on the way
     that became a link is skipped. The transcript read takes the same path. So a link an agent left
     in `.claude/projects` at `~/.aws/credentials`, or in place of `.pi/agent`, archives and reads
     nothing. sealantd captures a link as a link.
   - The test `secret-files.test.ts` builds the executor's listing over a relocated home with such
     links and shows the written file in neither the capture listing nor the harvest archive.

5. **The exec channel carries the bytes.** Base64 on argv of the platform's authenticated exec,
   decoded inside, like every other file Mend places. A launch-time injection the caller supplies,
   on the channel Core uses for its own credential files, would keep the bytes off argv and write
   them before readiness; it is asked for in PLATFORM-FEEDBACK.md and taken when it ships.

6. **Surfaces.** `mend secrets`, `mend secrets add <path> [--from <file>]` (stdin without `--from`),
   `mend secrets rm <path>`; the settings page lists, adds and removes; the phone lists.

## Considered

- **A dotfiles snapshot.** Applied at boot by the platform as a plain tree, held in the person's
  dotfiles store, and the person's own repository may carry it. Neither sealed nor refused from
  captured directories.
- **Project secrets with a file shape.** Per project, so the same file would be entered once per
  project; and an environment variable is not what the AWS CLI or kubectl read.
- **Waiting for a platform file injection.** The right channel, and asked for; waiting leaves the
  owner without the files. The exec path exists today and is what skills, pi profile and memory use.
- **A project-level secret file.** A later change, as the owner decided.

## Consequences

- A session the person owns has `~/.aws/credentials` and the rest where the tools read them, in
  every project, from the next launch after a save.
- The bytes cross the platform's exec as base64 argv for the duration of one exec, as skills and
  memory do, and are not persisted by the platform. A logger of exec argv would see them; the SDK
  has none, and the launch-time channel is requested.
- A file on a path dotfiles turned into a symlink is not written; the session summary names it.
- In capture mode, the executor of a leased worktree is one person's home. A second person's session
  joining it runs beside the holder's files and without its own; this was already true of the
  holder's provider logins, and secret files do not widen it.
- A lost `secrets.key` loses project secrets and secret files alike: enter them again.
- Running sessions keep the files they have; a removed file is removed from the next launch on.

## Decision log

- 2026-10-03: exec after relocation, not a dotfiles archive or a platform injection that does not
  exist; both stores share one path.
- 2026-10-03: refusal list kept in `@mend/domain` with a test against `@mend/sessions`'s harness
  table, rather than importing the sessions package into the domain.
- 2026-10-03: a retained executor receives the set again before each run, so a replace reaches a
  long-lived session's next run without a relaunch.
- 2026-10-03: a join into another person's executor receives no secret files there. Writing the
  joiner's files into a home the holder's agent reads would hand them to the holder.
- 2026-10-03, after the first Astra review: each delivery stages under its own stamp and proves the
  path again before every chunk and the rename, since a planted staging file under a symlinked
  directory took later chunks; a delivery records what it wrote in `~/.mend/secret-files` and the
  next one removes what the person no longer keeps, since a retained executor kept a deleted file;
  the co-located harvest excludes every symlink at or below a harvested path and the transcript read
  refuses a link, since `tar -h` dereferenced a link an agent left in `.claude/projects` at a secret
  file; the repo refuses a size outside 1 byte to 256 KB.
- 2026-10-03, after the second Astra review: the harvest and the transcript read go through the
  relocation's own links only and follow no other, since a directory on the way replaced by a link
  still led `tar -h` and `cat` out of the harness home; the home's record is sealed, bound to the
  workspace and carries each file's digest, since a plain record could be forged to make Mend remove
  a file it did not write, or linked at a secret file to log its lines as paths; a refused removal
  stays recorded. Client caches keyed without the account remain, as every other settings query on
  those pages is keyed.
