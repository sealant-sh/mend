# Harness credential files are never saved or restored

- **Release:** 0.36
- **Status:** sealantd side on main (sealantd#136 merged as `07ada506a`; pinned into Mend main
  through Core `0.39.0-next.683`, which bakes `sealantd-next:0.20.0-next.142`, mend#532). Codex
  daemon off on main (mend#527). Mend's mirror of the tables, the sibling-aware mode keeper and the
  Codex shell-snapshot flag are in review (mend#526, open, on hold; to be trimmed per ADR 0016
  Delivery 6). Per-person homes, under which the tables become a second layer, are designed
  (mend#534, ADR 0016, open), not built.
- **PRs:** sealantd#136 (merged), sealantd#127 (merged, earlier pi/opencode logins), mend#527
  (merged), mend#526 (open), mend#503 (merged: opencode MCP login link, captured-login drop),
  mend#532 (merged: the pin), mend#534 (open: ADR 0016).
- **Decision records:** Sealantd docs/adr/0015-session-capture-and-sync.md ("Harness credentials",
  "Harness machine state"); Mend docs/adr/0002-session-capture-store.md,
  docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md,
  docs/adr/0008-one-refresher-for-provider-logins.md, docs/adr/0016-per-person-harness-homes.md (§2,
  mend#534, open).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec426e`, sealantd main
  `07ada506a`. mend#526 read at `ac3bdce06`.

## Why it exists

In capture mode (ADR 0002) a worktree's harness home is saved with every capture and restored into
the next executor of that worktree, whoever starts it. Mend's relocation links `~/.claude`,
`~/.codex`, `~/.pi`, `~/.local/share/opencode` and `~/.local/state/opencode` into that home, so
anything a harness writes there travels to the next person. Before sealantd#136 only five login
files were left out (`CREDENTIAL_FILES`), and the list failed open: a credential it did not name was
saved, and the next person inherited it.

The 2026-10-04 audit (Claude Code 2.1.289, Codex 0.160.0, opencode 1.18.34, pi 1.0.2, each run after
a clean exit and after SIGKILL mid-turn) found 22 more: MCP OAuth tokens (Codex, opencode, pi),
Codex's shell snapshot holding every exported variable with its value (`GH_TOKEN`, dotfile exports),
Claude's backups of `~/.claude.json`, `file-history/` holding a copy of any file Claude edits (a
secret file included), clone URLs with tokens in opencode's `repos/` and `log/`, pi's `mcp.json`.
Everyone sharing a worktree, at once or in turn, was exposed; every capture put the tokens into the
bucket.

Separately, a hand-typed or Mend-launched Codex 0.160 TUI starts a shared app-server daemon that
first copies about 427 MB into `~/.codex/packages/`, which every capture saved and every later
executor restored (mend#527).

Owner rules: one person's credentials are never spent by or exposed to another; no person ever uses
anyone else's login.

## What it does

- A harness writes a login, token or credential-bearing file into its home inside a workspace. In
  capture mode sealantd never lists it in a capture, never watches it, and never writes it back on a
  restore, including from a capture made before the path was listed.
- The platform's own logins arrive at every launch as copies that cannot refresh (ADR 0008): Claude
  `.credentials.json` without a refresh token, Codex `auth.json` with a placeholder. Mend's pi and
  opencode logins are copies of the Codex one with the placeholder `sealant-copy-cannot-refresh`.
- Every Codex launch Mend shapes for a Codex session carries `-c features.daemon_auto_start=false`:
  no daemon, no 427 MB copy.
- In review (mend#526): every such launch also carries `-c features.shell_snapshot=false`; Mend
  keeps one table of credential paths equal to sealantd's, tested; the co-located mode keeper and
  harvest use the full table; the docs page "What a session never saves" lists it.
- Nothing is visible in the UI. The person notices only that an MCP sign-in, an edit to pi's
  `mcp.json`, or Claude's file-edit rewind does not survive onto a new executor.

**In scope.**

- sealantd `HARNESS_CREDENTIALS` (27 entries) and `HARNESS_MACHINE_STATE` (3 entries): capture
  listing, watcher, restore skip, the sibling rule.
- Capture-mode relocation dropping a captured opencode `mcp-auth.json`, and opencode's MCP-login
  link into the executor's own home.
- Co-located mode: the mode keeper never opens up a credential; the harvest archive never contains
  one.
- Codex daemon off (mend#527); Codex shell snapshot off (mend#526, in review).
- Mend's mirror of the tables and the test that holds it to sealantd's (mend#526, in review).
- Under ADR 0016 (designed): logins live outside every capture root; the tables stay as a second
  layer and sealantd applies them under each `people/<id>/` too.

**Out of scope.**

- Settings files that can also hold a secret a person typed in: Codex `config.toml`, Claude
  `settings.json` `env`, pi `models.json` and `settings.json` (including a package URL with a
  token), pi's `git/` clones (same URL). Saved on purpose on main; ADR 0016 stops saving settings.
- opencode's database (`account`, `control_account`, `credential` tables): saved, because resume
  needs it. Documented in Known issues; ADR 0016 makes it per person, still saved.
- Live exposure inside one executor: everyone in it runs as root and can read every file, the
  holder's injected login included (ADR 0016 §10).
- A joiner spending the holder's login (Core injects one login per workspace at create): a login
  question, covered by ADR 0013/0016 and the steering spec.
- pi profile carry-over between people (`PI_PROFILE_IN_USE`, mend#526): being replaced by per-person
  homes; not specified here.
- Claude `.claude/debug/`, `telemetry/`: not listed (mend#526 "Not covered").

## How it works

### Where logins come from

- Core plans injections (`Core packages/credentials/src/injection.ts:34-82`): Claude OAuth →
  `$HOME/.claude/.credentials.json` mode 600, a copy without the refresh token; Claude setup token →
  env `CLAUDE_CODE_OAUTH_TOKEN` (sealant#316, open, moves it to a file); Codex →
  `$HOME/.codex/auth.json` mode 600, placeholder refresh token; GitHub → env `GITHUB_TOKEN` and
  `GH_TOKEN`. Written over the executor's control connection before the workspace reports ready;
  refreshed copies are pushed to the same paths (ADR 0008).
- Mend's seeds (`packages/sessions/src/harness-seeds.ts`): the Claude seed writes
  `~/.claude/.credentials.json` from `CLAUDE_CODE_OAUTH_TOKEN` only where none exists (`:32-35`);
  `CHATGPT_LOGIN_PROGRAM` (`:97-109`) writes pi's and opencode's `auth.json` entry from the Codex
  copy, only when absent or itself an earlier copy, refresh = `COPY_REFRESH_TOKEN` (`:81`).
- Relocation (`relocateHarnessHomeScript`, `packages/sessions/src/harness-state.ts:423-525`) moves
  `$HOME/<dir>` into `/workspace/harness-home/<dir>` (keeping what the mount already holds) and
  links it back, before any harness starts. So injected logins physically sit inside the captured
  root `harness/`.

### sealantd: never captured, never restored

`crates/sealant-capture/src/index.rs` (sealantd `07ada506a`):

- `HARNESS_CREDENTIALS` (`:111-275`): Claude `.credentials.json`, `.device-keys.json`, `backups/`,
  `shell-snapshots/`, `session-env/`, `ide/`, `sessions/`, `file-history/`, `remote-settings.json`;
  Codex `auth.json`, `.credentials.json`, `secrets/`, `shell_snapshots/`; opencode `auth.json`,
  `mcp-auth.json`, `repos/`, `log/`; pi `auth.json`, `mcp-auth.json`, `oauth.json`, `mcp-oauth/`,
  `mcp-oauth-encrypted/`, `mcp.json`, `tmp/`, `crashes.json`,
  `.pi/agent/mend/profile/root/mcp.json`, `.mend/pi-profile-kept/`.
- `HARNESS_MACHINE_STATE` (`:282-301`): `.codex/packages/`, `.codex/app-server-daemon/`,
  `.codex/app-server-control/`.
- `is_harness_excluded_path` (`:312-324`): a `File` entry matches the path and any sibling
  `<path>.<suffix>` (and anything under one); a `Dir` entry matches the path and everything under
  it. Leading and trailing `/` trimmed; relative to the harness home root only.
- Capture listing (`roots.rs:151-165`): excluded directories are not walked; excluded files, or
  whatever stands at their path, are left out.
- Watcher (`watch.rs:351`): events under excluded paths are ignored.
- Restore (`materialize.rs:495-508`, `is_harness_credential`): an entry at an excluded path in any
  capture, old or new, is skipped before any fetch; the sweep reads the same listing, so a login the
  platform injected into the live home is never swept.
- The two tables are held to ADR-0015's sections by `the_adr_lists_every_harness_exclusion`
  (`tests/round_trip.rs:846`).

### Mend on main

- `HARNESS_HOME_CREDENTIALS` (`harness-state.ts:240-247`): five paths (Claude and Codex logins, pi
  and opencode `auth.json`, opencode `mcp-auth.json`).
- Co-located mode keeper (`harness-state.ts:500-506`): a detached loop runs `chmod -R go+rX` on the
  harness home every 15 s so the store-side reader (another uid) can read transcripts, then
  `chmod go-rwx` on each of the five exact paths.
- Co-located harvest (`harvestHarnessStateScript`, `harness-state.ts:380-396`): `tar` with `-X`
  listing the five paths and carried transcripts, following no link.
- Capture-mode relocation with `dropCapturedLogins` (`engine.ts:9612-9616`,
  `harness-state.ts:507-518`): a plain `.local/share/opencode/mcp-auth.json` is removed unread; a
  link there is kept only when it leads to `$HOME/.mend/opencode/mcp-auth.json`. Runs before every
  launch and resume, shells included.
- `OPENCODE_CAPTURED_SEED` (`harness-seeds.ts:153-179`), capture launches of opencode only: makes
  `mcp-auth.json` a link to `~/.mend/opencode/mcp-auth.json` (executor's own home, outside every
  capture root), refuses to start opencode when that directory resolves under `/workspace` or the
  link cannot be made.
- `withoutCodexDaemon` (`harness-seeds.ts:318-334`): adds `-c features.daemon_auto_start=false`
  after `codex` unless any arg is `--no-daemon`, `daemon_auto_start`, or starts with
  `features.daemon_auto_start=`. Applied in `withHarnessSetup` for the `codex` harness (`:347-349`:
  terminal, app-server, resume, join, claimed standby) and inline in `promptArgv`
  (`engine.ts:505-506`: prompts, review follow-ups, handoffs).

### mend#526 (in review, `ac3bdce06`)

- `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE` in `harness-state.ts`, per harness, each entry
  `{path, kind, holds}`; `HARNESS_HOME_CREDENTIALS` derived from the first.
- Tests fail when the table does not cover exactly the harnesses Mend runs, names a path outside the
  harness home, differs from a hand copy of sealantd's table, or differs from the docs page.
- `tightenCredentials` tightens `"$c" "$c".*` (siblings: `oauth.json.migrated`,
  `auth.json.mend-seed-<pid>`).
- `.claude/sessions` removed from Claude's harvested paths.
- `CODEX_SHELL_SNAPSHOT_OFF` (`-c features.shell_snapshot=false`) via `withoutCodexShellSnapshot` in
  `withHarnessSetup` and inline in `promptArgv`. `CODEX_TRUST_SEED` (and so `config.toml`) is not
  changed. The branch predates #527 and conflicts; resolution recorded in mend#527's body.
- pi profile rule (`PI_PROFILE_IN_USE`, foreign-profile clearing): dropped from the branch per ADR
  0016 Delivery 6.
- Docs: "What a session never saves" on concepts/provider-logins, with the "applies once Mend pins a
  runtime with sealantd#136" qualifier.

### Under ADR 0016 (designed)

Logins, settings and Codex's databases live in `/root/.mend/homes/<account>` (`R`) or
`/root/.mend/logins/<session>` (`L`), outside every capture root; only conversations and memory sit
in `harness/people/<account>/` (`P`). sealantd applies both tables under each `people/<id>/` as well
as at the root (ADR 0016 Delivery 2), so a credential a harness writes into a saved directory, or a
link replaced by a plain file, is still never saved. Mend keeps its copy of the tables and the test
(Delivery 6).

### Ordering and restart

- Restore runs at executor boot, before relocation; the skip happens there.
- Relocation and the captured-login drop run before any Mend process starts in the executor; a
  failure abandons a capture executor.
- An executor restart rebuilds the recorded spec, so it lands on the launcher's login; logins are
  never read from a capture.

## Happy path

Anna and Maria, project `api`, capture mode, sealantd `0.20.0-next.142`.

1. Anna starts `mend codex --name oauth`. Core writes `~/.codex/auth.json` (placeholder refresh);
   relocation moves it into `/workspace/harness-home/.codex/auth.json`. The argv is
   `codex -c features.daemon_auto_start=false -c features.memories=true …`. `ls ~/.codex/packages`
   in a shell of hers: no such directory.
2. Anna's Codex connects an MCP server; Codex writes `~/.codex/.credentials.json`. Anna's agent runs
   a tool with `GH_TOKEN` exported; on main Codex writes `~/.codex/shell_snapshots/<thread>.sh`.
3. Captures run. The capture's `harness/` listing holds `.codex/sessions/…` and
   `.codex/config.toml`, and none of `.codex/auth.json`, `.codex/.credentials.json`,
   `.codex/shell_snapshots/…`.
4. Anna's executor is killed (SIGKILL). The snapshot file is left on disk; it was never captured.
5. Maria starts a session in `oauth`. Her executor restores the head:
   `ls /workspace/harness-home/.codex` shows `sessions`, `config.toml`, no `auth.json` other than
   the one Core injected for Maria, no `.credentials.json`, no `shell_snapshots`. Her Codex asks to
   sign in to the MCP server again.

## Invariants

1. No path in sealantd's `HARNESS_CREDENTIALS` or `HARNESS_MACHINE_STATE`, no `<file>.<suffix>`
   sibling of a file entry, and nothing under a directory entry, relative to the harness home root,
   appears in any capture listing, snap index or uploaded pack.
2. No restore writes such a path, whatever any capture (made before or after the entry was listed)
   holds, and no sweep removes a login the platform injected into the live home.
3. Every login the platform or Mend writes into a workspace is a copy that cannot refresh: no
   refresh token (Claude), the placeholder (Codex, pi, opencode copies).
4. Mend never holds the bytes of a platform login; it names a person and an account, Core writes.
5. The co-located harvest archive contains no file named in `HARNESS_HOME_CREDENTIALS`; the mode
   keeper leaves each of them `go-rwx` after every pass.
6. In capture mode, no Mend-started process in an executor sees a plain opencode `mcp-auth.json`
   that a restore brought, or a link at that path leading anywhere but the executor's own
   `~/.mend/opencode/`.
7. Every argv Mend shapes for a `codex`-harness launch (terminal, app-server, resume, join, claimed
   standby, prompt, follow-up, handoff) carries `features.daemon_auto_start=false` unless the launch
   named the setting or `--no-daemon` itself.
8. (mend#526, in review) Every such argv carries `features.shell_snapshot=false` unless the launch
   named it; Mend's credential table equals sealantd's, path by path, kind by kind.
9. (ADR 0016, designed) No person's login file ever sits inside a captured directory; one person's
   login never sits at a path another person's process reads.

## Edge cases and failure behaviour

**Concurrent actions**

- A harness writes a credential while a snap walks the home: excluded by path, so a half-written
  file or its `.tmp` sibling (`.mend-seed-<pid>`, `.mend-part`, `.lock`) is never listed.
- A joiner and the holder in one executor: both read the holder's live login files (root); nothing
  is captured. Not a capture leak; a live-exposure limit (ADR 0016 §10).
- Two opencode launches into one executor: both end with the same link (`ln -sfn` plus readlink
  check).

**Restarts**

- SIGKILL of a harness: files it deletes on clean exit (Codex and Claude shell snapshots) stay on
  disk, excluded from capture by directory.
- sealantd restart: the listing and restore rules are code, not state.
- Mend restart: nothing to recover; the next relocation re-runs the drop.

**Partial failures**

- The captured-login drop cannot remove the file: relocation fails, the capture executor is
  abandoned, the launch fails.
- opencode's MCP link cannot be made: opencode does not start
  (`mend: opencode's MCP logins cannot be kept out of saved state here; not starting opencode`).

**Odd input**

- A symlink at a credential path: neither listed nor followed; restore skips whatever stands there.
- A directory at a file entry's path: pruned (stricter than before).
- `auth.jsonl`, `auth.json-other`: not siblings, captured (no harness writes them).
- A link elsewhere in the home pointing into a credential directory: captured as link text only.
- A credential written under a path a person renamed or linked
  (`ln -s ~/.codex/auth.json ~/notes/a`): the link is captured as a link; the bytes are not.
- A `codex` typed by hand in a shell or terminal: no Mend flags. Daemon starts and copies 427 MB
  into `.codex/packages/` (not captured); shell snapshots written (not captured).
- `mend run -- codex` (harness `run`): no daemon flag either (see Divergences); same outcome.

**Older data**

- Captures made before sealantd#136 still hold `.codex/.credentials.json`, Claude `backups/`,
  opencode `mcp-auth.json`, `.codex/packages/` and others: never restored. They stay in the bucket
  until the captures are collected.
- A Mend main pinned to a sealantd without #136 (older Core pins): only the five old paths are left
  out. Mend main today pins `0.20.0-next.142`, which includes #136; Mend 0.36 needs Core 0.39.0
  stable with sealantd 0.20.0 (release chain, ROADMAP).
- pi profiles restored without `root/mcp.json` on main (see Divergences).

**Permissions**

- Owner, member, steerer: no difference in what is saved; the rule is by path.
- Operator: no access to captures through Mend.
- Bucket readers (whoever holds store credentials): see only non-excluded paths in new captures.

**Clients**

- No client surface. Every launch path (web, CLI, desktop, phone, VS Code, Slack, t3 gateway) goes
  through the engine's relocation and seeds; VS Code takeover runs `codex resume` by hand in a
  Remote-SSH terminal, with no Mend flags.

## Known limits

- opencode's database holds console and integration logins and is saved (Known issues "opencode runs
  in the terminal only"; PLATFORM-FEEDBACK 2026-10-04).
- An MCP sign-in lasts one workspace; people joined on one workspace share opencode's MCP login file
  (Known issues, opencode).
- Settings that can hold a typed secret are saved (mend#526 docs; ADR 0016 changes this).
- `.pi/agent/mcp.json` changes in a session (`pi mcp add`, `/mcp` toggles) last one executor; Claude
  `file-history/` rewind does not survive a new executor (mend#526 docs).
- `features.daemon_auto_start=false` stops auto-start only; a TUI can still attach to a daemon
  already running in the executor (mend#527 review P3).
- The tables fail open: a credential a harness version adds is captured until listed (sealantd
  `index.rs:104-110`).
- Everyone in one executor reads everyone's live files (ADR 0016 §10).

## How to verify

**Tests**

- sealantd: `cargo test -p sealant-capture`: `capture_leaves_every_harness_credential_out`
  (`tests/round_trip.rs:887`), `a_legacy_capture_s_harness_credential_is_never_restored` (`:675`),
  `the_adr_lists_every_harness_exclusion` (`:846`),
  `materialize::tests::a_captured_harness_credential_is_never_restored` (`src/materialize.rs:1700`).
- Mend main: `packages/sessions/src/harness-state.test.ts` "the co-located harvest keeps no login"
  (`:548`), "a login an older capture brought" (`:605-660`); `harness-seeds.test.ts` "Codex's
  background server" (`:558-591`), "opencode's seed: MCP logins stay out of saved state"
  (`:480-556`), "pi and opencode seeds: the ChatGPT login from the Codex copy" (`:286-372`).
- mend#526: `harness-state.test.ts` table-equality tests, `harness-seeds.test.ts` shell snapshot.
- Not covered: an end-to-end box run of a harness writing each listed file and a second person
  restoring; `mend run -- codex`; the mode keeper over the 22 paths not in Mend's five.

**On the box**

```sh
mend codex --name cred-check -d            # note the session id it prints, <s1>
mend shell <s1>                            # a shell in the executor
ls -la /workspace/harness-home/.codex /workspace/harness-home/.claude
ls /workspace/harness-home/.codex/packages # absent for Mend's launches
mkdir -p /workspace/harness-home/.codex/shell_snapshots
touch /workspace/harness-home/.codex/.credentials.json /workspace/harness-home/.codex/shell_snapshots/x.sh
exit                                       # close the shell, or it keeps the executor up
mend stop <s1>                             # wait until the executor has ended
mend codex --worktree cred-check -d        # <s2>, a fresh executor restoring the head
mend shell <s2>
ls -la /workspace/harness-home/.codex      # neither file is back; auth.json is the one Core injected
```

Check the argv on the session's process row or with `ps -ef | grep codex` inside the executor:
`-c features.daemon_auto_start=false` present.

**Signals**: sealantd logs `a captured harness credential is not restored` on a legacy capture
(`materialize.rs:1288`, also used for machine state); Mend's relocation failure
`harness-home relocation failed: remove a captured login: …`.

## Divergences found while writing

1. `packages/sessions/src/pi-profile.ts:66-68` with `packages/db/src/repos/pi-profiles.ts:34-41`: on
   main the pi profile's accepted digest includes `root/mcp.json`, which the pinned sealantd (#136)
   no longer saves or restores. Every pi launch on a new executor of a worktree whose restored
   profile had `root/mcp.json` reads the profile as changed, moves it whole to
   `.mend/pi-profile-kept/` (also excluded, so lost with the executor), writes it again and
   reinstalls its extensions; a failed install stops pi. mend#526 fixes this (cred-audit round 1
   P2-1) and is on hold. Shipping sealantd#136 without it is a regression for pi profiles with MCP
   servers.
2. `packages/sessions/src/harness-seeds.ts:347-349`: the daemon flag is added only when the
   session's harness is `codex`. A `mend run -- codex` (harness `run`) or any non-`codex` harness
   launching `codex` starts the daemon. mend#527 says "every Codex launch Mend makes". Capture
   impact is closed by `HARNESS_MACHINE_STATE`; the executor still carries the 427 MB and a daemon
   process.
3. `packages/sessions/src/harness-state.ts:240-252`: on main the co-located mode keeper opens every
   file under the harness home to group and other every 15 s and re-tightens only five exact paths,
   so the 22 newer credential paths (`.codex/.credentials.json`, Claude `backups/`, pi
   `mcp-auth.json`, …) are left group- and other-readable on the store (whether another host user
   reaches them depends on the modes of the store's parent directories). Fixed in mend#526 (open).
4. `packages/sessions/src/harness-state.ts:255-262`: `.claude/sessions` (per-process messaging
   tokens, a sealantd credential since #136) is still in Claude's co-located harvested paths on
   main, so it is archived into the store and put back at relaunch. Same person; fixed in mend#526.
5. Mend main has no Codex shell-snapshot flag: Codex writes every exported variable with its value
   into `.codex/shell_snapshots/` in the live executor. Never captured (sealantd), but readable by
   anyone joined while it exists. The flag is only in mend#526.
6. Mend main's docs do not list what sealantd now leaves out; "What a session never saves" is in
   mend#526 only.
7. sealantd `materialize.rs:1288` logs "a captured harness credential is not restored" for machine
   state too (cred-audit round 2 nit).
8. Not a code divergence but the standing rule: on main a joiner's agent, shell and terminal in
   another person's executor run on that person's injected login, and `GITHUB_TOKEN`/`GH_TOKEN` are
   container-wide (Core `injection.ts:74-80`). ADR 0016 §3-4 is the fix; not built.
