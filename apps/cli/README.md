# mend

The CLI for [Mend](https://github.com/sealant-sh/Mend) — a local-first workbench for developers who
use coding agents heavily. Adopt a repository into Mend's central store, run your agent (Claude
Code, Codex, or any command) in a recorded per-session git worktree, detach, and reattach from any
terminal.

```sh
npm install -g @sealant/mend
```

Requires Node 22+ and a running Mend server.

Run bare `mend` for the interactive dashboard. Highlight a session and press `v` to review its
accumulated change in the terminal: navigate files and hunks, switch between unified and split
diffs, reveal whitespace, select line ranges, add line or whole-change comments, inspect linked
evidence, and draft a follow-up for the same session. Press `y` to deliver a pending follow-up and
relaunch that session, or `o` to continue the review in the web app.

## Local server

On a machine with a local Docker daemon and Compose v2 (Linux is verified; macOS with Docker Desktop
or OrbStack is still being validated, see
[docs/MACOS-VALIDATION.md](https://github.com/sealant-sh/Mend/blob/main/docs/MACOS-VALIDATION.md)):

```sh
mend server setup
mend server status
mend server logs --tail 100
mend server stop
mend server start
mend server restart
```

Setup preserves the existing server pin even when this CLI is newer. To change the pin, use
`mend server upgrade --version TARGET`; `latest` is accepted only when explicitly requested. Upgrade
checks release assets and image labels before stopping app writers, then makes a private Postgres
database backup before target startup. Once migrations may have started, failures retain the target
pin rather than automatically downgrading or restoring the database.

For local release assets and preloaded images:

```sh
mend server setup --version 0.23.0 --assets-dir ./release-0.23.0 --offline
mend server upgrade --version 0.24.0 --assets-dir ./release-0.24.0 --offline
```

Each asset directory must contain `compose.v2.yaml` and `postgres-init.sh`. Mend copies them into an
immutable private generation; the source directory is not needed afterward. Preload official
`postgres:17-alpine` and canonical `ghcr.io/sealant-sh/mend:VERSION`. Image labels and health must
report that exact version. `--offline` forbids GitHub requests and release-image pulls.
Start/restart always reuse local release images and retained assets. The bundle publishes only the
web port (`--port`, default `3105`) and the SSH gateway port (`--ssh-port`, default `2222`); the two
must differ.

Stop/restart/upgrade interrupt connections. Workspace containers and data remain, but active work
may lose connectivity and need reconnection. No volumes are deleted. Status/logs never start an
installation or change its configuration. See [SERVER-RUNTIME.md](SERVER-RUNTIME.md) for the backup
layout, lock recovery, and migration-failure procedure.

## Getting started

Once per machine, in this order:

```sh
mend login                       # sign in to the server; the token is saved 0600
mend connect codex               # send this machine's codex (or claude, github) credential
mend adopt                       # adopt the repository you are standing in
mend codex "fix the flaky test"  # new session worktree, harness running in it
mend pair                        # hand a phone the same server
mend doctor                      # every fact above, on one screen
```

`mend help` prints the same sequence under `start`, then everything else.

### mend pair

```
mend pair [--url <base url>]
```

Asks the server for a pairing code and prints it three ways: a QR of the `mend://pair` deep link,
the code grouped as `ABCD-EFGH`, and the base URL the device should reach, chosen from the origins
configured on the server (`--url` selects one of them; it cannot add an address the server does not
know). Scan it in the Mend app, or type the URL and the code in by hand. The code is single use and
expires in 10 minutes; the device's own token is minted when it claims the code, and can be revoked
from the Mend app later. The device names itself when it claims the code.

### mend doctor

```
mend doctor
```

Reads, and changes nothing: server reachable, token accepted, the Sealant connection, each connected
account, adopted projects, the `claude` / `codex` / `gh` CLIs on PATH and whether their credentials
exist on this machine, and the tailnet address. One line per fact — `✓` observed, `○` not set up
yet, `✗` a blocker — and every line that needs an action ends with the one command that takes it:

```
✓ server      http://localhost:3105 · mend 0.5.0
✓ signed in   token accepted
✓ sealant     connected · http://127.0.0.1:4000
✓ claude      connected · you@example.com
○ codex       not connected → mend connect codex
✓ projects    2 adopted
○ gh cli      on PATH · no credential here → gh auth login
○ tailnet     not detected
```

It exits 1 when a `✗` is printed, so a setup script can gate on it. No request waits longer than 3s.

## Commands

```
mend adopt [git-url] [--name <name>]  clone a network Git repository into the store
                                      (default: the current checkout's origin URL)
mend codex|claude|opencode            new session worktree + launch the harness in it
mend run -- <command...>              same, with an arbitrary command
mend attach <session-id-prefix>       reattach this terminal to a running session
mend continue [session-id]            resume a session with its pending review follow-up
mend resume [session-id] [--with h]   rejoin a settled session (state restored; --with switches harness)
mend rejoin [session-id] [--harness h] attach if live, otherwise resume; newest live wins
mend sessions [--all] [--project p] [--json]
mend status                           active sessions (alias of mend sessions)
mend pair [--url <base url>]          pair a phone or a second machine: QR + code + URL
mend doctor                           read-only checklist of this machine's setup
mend skills [--project [p]]           your skill library on the server (or a project's)
mend skills push [--project [p]] [--prune] [--dir <path>]
                                      upload ~/.agents/skills bundles; sessions receive
                                      them at launch (--prune removes what's gone)
mend keys init|show|mode|share        your Mend git key, default access mode, agent bridge
mend ssh [setup]                      workspace SSH status; register a key + Host block
mend server <command>                 this machine's Docker server: setup, status, logs,
                                      start, stop, restart, upgrade
mend version                          this CLI's version, and the server's when it answers
```

## Signing in

```
mend login                 # opens the browser at <server>/authorize; press Authorize there
mend login --url https://mend.example.com
mend logout                # revokes this terminal's device token and forgets it
```

`mend login` opens the browser at `<server>/authorize?code=…` and waits, using the server already
configured (`--url`, `MEND_URL`, or the config file). Only a fresh machine with nothing set asks for
the URL, with Enter accepting `http://localhost:3105`. Sign in there if needed, check that the code
on the page matches the one in the terminal, and press **Authorize**. The CLI receives a device
token of its own, the same revocable kind a paired phone holds, listed under Settings → Devices. No
password is ever typed into the terminal. Over SSH the browser does not open by itself; open the
printed URL on any signed-in device instead.

The token is stored 0600 in the CLI config below; every command uses it until `mend logout`. On a
dev instance with `MEND_STATIC_TOKEN` set, `MEND_TOKEN=<that value>` also works.

## Workspace SSH

```sh
mend ssh                          # inspect config and this client's key registration
mend ssh setup                    # register a key and reconcile this server's Host block
mend ssh setup --key ./my-key      # explicitly select private key or its .pub file
mend ssh setup --host mini.tailnet.ts.net
```

Setup puts the managed block before wildcard defaults and restores all-host scope before your
original configuration. It preserves other servers and hand-written Host/Match rules. If moving an
older block would change the scope of trailing directives, it refuses the write; put those
directives in an explicit Host or Match block and rerun setup.

Relative `--key` paths resolve against the invoking directory; `~/` resolves against your home.
Identity paths with spaces, quotes, backslashes and literal `%` are escaped for OpenSSH. Control
characters, `~user` paths and `${…}` expansions are rejected. Mend reuses a selected key, never
silently substitutes another identity when it disappears. A readable, unencrypted private key must
match the public half; otherwise the exact public identity must be available in an unlocked
ssh-agent. Unlock encrypted keys yourself with `ssh-add` before setup. Checks are noninteractive and
time-bounded. First setup can pin an agent public key or generate a dedicated key under the Mend
config directory. Later setup preserves private keys.

Status and setup report config and client-key registration, not a successful SSH connection or
verified host trust. The public Sealant SDK's gateway info supplies host, port and username prefix,
not a host-key fingerprint. Mend cannot authenticate a rotated host key from that metadata.

### Gateway host-key rotation

Mend uses a stable per-server `HostKeyAlias`. OpenSSH's `accept-new` policy accepts an unknown key
on first connection, but refuses a changed key. Rerunning setup does not replace or remove any
`known_hosts` entry. Treat a mismatch as a possible interception until verified.

1. On the trusted server, through its console or a separately trusted administrative connection,
   find the SSH host-key file configured for the **gateway container**, not a session workspace.
   Read its SHA-256 fingerprint there. For Docker, substitute the actual container and its
   configured host-key file in this command:

   ```sh
   docker exec GATEWAY_CONTAINER ssh-keygen -lf HOST_KEY_FILE -E sha256
   ```

   Use the host key or its `.pub` file; do not copy or print private key contents. Keep the gateway
   host-key storage persistent across ordinary restarts. A genuine rotation should be deliberate.

2. Compare that fingerprint out-of-band with the gateway fingerprint in the client's SSH warning. If
   they differ, or you cannot access the trusted server, stop. `ssh-keyscan` alone is not
   verification, and an API response containing only host/port does not establish host trust.
3. Only after the fingerprints match, locate this server's exact `HostKeyAlias` and
   `UserKnownHostsFile` with `ssh -G YOUR_MEND_ALIAS`. Back up that known-hosts file. Remove only
   the exact alias entry from that file, not the hostname, other server aliases, or the whole file:

   ```sh
   ssh-keygen -F 'EXACT_HOST_KEY_ALIAS' -f ~/.ssh/known_hosts
   ssh-keygen -R 'EXACT_HOST_KEY_ALIAS' -f ~/.ssh/known_hosts
   ```

   Replace the alias and file path with the values you inspected. These commands also find and
   remove hashed entries for that exact alias.

4. Reconnect explicitly with `ssh -o StrictHostKeyChecking=ask USER@YOUR_MEND_ALIAS`. Compare the
   prompt's fingerprint with the trusted-server fingerprint again before accepting. A different
   fingerprint is a reason to stop, not to bypass host-key checking.

## Configuration

| Source                    | What                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `MEND_URL`                | The Mend server (default `http://localhost:3105`)                                                          |
| `MEND_TOKEN`              | Bearer token for that server (normally written by `mend login`)                                            |
| `MEND_DETACH_KEY`         | Set to `none` when an outer multiplexer detaches                                                           |
| `~/.config/mend/cli.json` | `{ "url": ..., "token": ..., "deviceId": ... }` — env vars win; a pre-XDG `~/.mend/cli.json` keeps working |

## Herdr

When Mend attaches Codex, Claude Code, or OpenCode inside a Herdr pane, it reports that harness to
Herdr for the lifetime of the attachment. The session therefore appears in Herdr's Agents sidebar
whether it was started from the `mend` dashboard or a one-shot CLI command. Mend supplies Herdr's
foreground-process hint rather than claiming lifecycle authority, so Herdr continues to derive
working, idle, and blocked from its native agent screen rules.

## Building and checking the npm package

`pnpm --filter @sealant/mend typecheck` uses tsgo without emission.
`pnpm --filter @sealant/mend build` bundles the CLI and its private workspace dependencies with
esbuild, follows transitive imports, and generates the man pages. Split chunks stay directly in
`dist/` so package-relative version reads work. Only declared public runtime dependencies remain
external. The dashboard still loads OpenTUI lazily; ordinary commands do not require its native
runtime. Source files remain runnable by the existing tests.

`pnpm --filter @sealant/mend test:package` packs the CLI and uses npm to install the tarball into a
fresh directory outside the checkout. It needs registry access. The smoke test checks the published
files and runs server-independent commands with OpenTUI temporarily removed. Set
`MEND_KEEP_PACKAGE_TEST=1` to retain the printed directory and installed package for inspection.
Neither installation nor the build installs or starts a Mend server.

## How it works

Every session runs in its own git worktree over the adopted repository, inside a recorded workspace.
The terminal you see is a held WebSocket to that workspace's PTY: `Ctrl+]` detaches and the session
keeps running; `mend attach` reconnects with full scrollback — from this machine or any other that
can reach the server. When a session settles, Mend harvests the harness's own state into the store,
so `mend resume` restores it natively (a Claude session resumes with its memory intact, even across
machines), and `--with` carries the conversation into a different harness.

The reviewable object is the session's accumulated local change — worktree versus base — with the
session record beside it. Review it in the terminal dashboard or the Mend web app. No issue tracker
or pull request required.
