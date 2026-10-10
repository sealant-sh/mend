# Uninstall

`mend uninstall` is the one command that deletes. It removes the local server, this machine's Mend
files, or both. Without a scope it asks which, then prints exactly what will go before touching
anything. Removing the server takes its containers, every volume it owns (repositories, worktrees,
session captures, the database), its release image and its private configuration with generations
and backups, and needs the typed word `delete`. Removing this machine's files revokes this
terminal's device token on the server first, then removes `cli.json`, the workspace SSH key and the
managed block in `~/.ssh/config`. Anything else is listed and left in place, and workspace
containers are named with the command that removes them, never removed.

## Sub-features

- `uninstall-ask-scope` asks `what should go?` with three numbered choices when no scope is given.
- `uninstall-plan` prints one line per thing that goes before asking.
- `uninstall-confirm` asks for the word `delete` when the server is in scope, `y` otherwise.
- `uninstall-server` removes the Compose installation, its owned volumes, its image and its private
  configuration.
- `uninstall-home` revokes the device token and removes the sign-in, the SSH key and the managed
  `~/.ssh/config` block.
- `uninstall-all` does both, server first.
- `uninstall-leftovers` lists what stays and why: unowned volumes, workspace containers, other files
  in the configuration directory.
- `uninstall-yes` skips the question with `--yes`, which a run without a terminal requires.

## How to get to it (user POV)

- CLI: `mend uninstall [--all | --server | --home] [--yes]`.
- CLI: `mend help uninstall`; the install and VPS docs end with it.
- Web, TUI, desktop, mobile, VS Code and Slack: not a surface for this feature. A revoked device
  shows as gone under the web Settings `Devices` panel, which is the
  [pairing-devices](./pairing-devices.md) feature.

## Driving it with verify

Preconditions:

- Every step runs on the disposable host from [the local server](./server.md), with a server that
  recipe installed and still running, and with the same `XDG_CONFIG_HOME=<scratch>/config` and
  `HOME=<scratch>/home`. Never on the owner's machine or Launch's stack: this deletes repositories
  and the database.
- The CLI there is signed in to that disposable server with `mend login --url <url>`, so the device
  token the home steps revoke is a disposable one and the server that must answer the revocation is
  still up. `MEND_URL` and `MEND_TOKEN` are unset: the plan and the revocation use the effective CLI
  URL, and `MEND_URL` overrides the saved one. Keep the saved token as `<token>` for the second
  view.
- `<scratch>/home/.ssh/config` exists; it may hold a managed block from `mend ssh setup`.
- The steps run in this order: the home scope while the server still answers, then the server scope.

- **Help page.** Run `mend help uninstall`. Stdout starts
  `mend uninstall · remove the server, this machine's Mend files, or both` and lists `--all`,
  `--server`, `--home` and `--yes`. Exit code `0`.
- **Usage errors.** Run `mend uninstall --server --home`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · pick one scope`, exit `1`. Run
  `mend uninstall --everything`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · "--everything" is not an option`,
  exit `1`.
- **No terminal, no scope.** Run `mend uninstall < /dev/null; echo "exit $?"`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · no terminal to ask on`, and the
  echo prints `exit 1`. (Do not pipe the command into another: the pipeline would report the last
  command's exit code, not mend's.)
- **Plan only, home.** Run `mend uninstall --home < /dev/null; echo "exit $?"`. Stdout reads
  `mend uninstall · home`, then `  home     <scratch>/config/mend/cli.json (signed in to <url>)`,
  plus `<scratch>/config/mend/ssh` and `1 managed block in ~/.ssh/config` (or
  `<n> managed blocks in ~/.ssh/config`) lines when present, and, while `cli.json` holds a sign-in,
  `this machine's workspace ssh key on <url>, if registered`. No `delete` line is printed. Stderr
  reads `mend: non-interactive — pass --yes to remove`, and the echo prints `exit 1`.
- **Remove the home files.** Run `mend uninstall --home --yes`. Stdout shows
  `revoked this terminal's device on <url>`, `removed <scratch>/config/mend/cli.json`, the SSH key
  and managed-block removals when they existed, and `✓ this machine no longer holds Mend files`. The
  configuration directory still holds the server's files, so a
  `  kept · <scratch>/config/mend kept: … are not this CLI's (…)` line names them instead of a
  `removed <scratch>/config/mend` line. Exit code `0`.
- **Revoked, second view.** The server still runs. Run
  `MEND_URL=<url> MEND_TOKEN=<token> mend doctor`. The first line reads `✓ server` and the second
  `✗ signed in   token rejected → mend login`. Run `MEND_URL=<url> mend doctor` with no token in the
  environment. The second line reads `✗ signed in   no token saved → mend login`. (Without
  `MEND_URL` the CLI falls back to `http://localhost:3105`, since `cli.json` is gone.)
- **Plan only, server.** Run `mend uninstall --server < /dev/null; echo "exit $?"`. Stdout reads
  `mend uninstall · server`, then `  server   Mend <v> at <url> · docker context <ctx>`,
  `           containers mend, postgres, garage · volumes mend-store, mend-control, mend-garage, mend-config, mend-ssh, mend-postgres · image ghcr.io/sealant-sh/mend:<v>`,
  `           <scratch>/config/mend: identity.env, active, <n> generation<s>, <m> backup<s>` (the
  nouns are singular for one: `1 generation`, `0 backups`), and
  `repositories, worktrees, the database and its backups are deleted with the server`. Stderr reads
  `mend: non-interactive — pass --yes to remove`, and the echo prints `exit 1`. `mend server status`
  still reads `Pinned Mend <v>`: nothing was removed.
- **Ask and decline.** In a PTY, run
  `tmux new-session -d -s verify-uninstall -x 200 -y 50 'mend uninstall; echo "exit $?"; sleep 600'`.
  The screen shows `what should go?`, then
  `  1. everything · the server on this machine and this machine's Mend files`,
  `  2. the server only · containers, volumes, configuration, backups`,
  `  3. this machine's files only · sign-in, workspace ssh key, ~/.ssh/config block` and the prompt
  ` 1, 2 or 3:`. Send `tmux send-keys -t verify-uninstall 2 Enter`. The server plan prints, then
  `type delete to remove: `. Send `tmux send-keys -t verify-uninstall no Enter`. The screen shows
  `nothing removed` and `exit 0`. With no server installed, `2` prints
  `server   none installed under <scratch>/config/mend` and `nothing to remove` and exits `0`
  without asking, and `1` or `3` ask `remove? [y/N]`; answering `n` prints `nothing removed` and
  `exit 0`.
- **Remove the server.** Before it, run
  `docker --context <ctx> container ls --all --filter name=^sealant- --format '{{.Names}}'` and note
  what it lists. Run `mend uninstall --server --yes`. Stdout shows the plan, then
  `removed containers mend, postgres, garage and the Compose-owned volumes`,
  `removed volumes mend-store, mend-control, mend-garage`,
  `removed image ghcr.io/sealant-sh/mend:<v>`,
  `removed <scratch>/config/mend/{identity.env, active, generations, backups}`, any `  kept · …`
  lines, and `✓ the server is gone from this machine`. Exit code `0`.
- **Server gone, second view.** Run `mend server status`. Stderr reads
  `mend: No Mend server is configured. Run mend server setup explicitly to install one.`, exit `1`.
  Run `docker --context <ctx> volume ls --format '{{.Name}}'`. No `mend-store`, `mend-control` or
  `mend-garage` is listed. When the container listing before the removal named `sealant-…`
  containers, the removal printed
  `  kept · 1 workspace container left on docker context <ctx> (<name>): docker --context <ctx> rm -f <name>`
  (or `<n> workspace containers …` for several), and the same listing still names them. When it
  named none, no such line appears.
- **Nothing left.** Run `mend uninstall --all --yes`. Stdout reads `mend uninstall · everything`,
  `  server   none installed under <scratch>/config/mend`, `  home     nothing of Mend's here` and
  `nothing to remove`. Exit code `0`.
- **Proof.** Keep every transcript with stdout, stderr and exit code, the `tmux capture-pane -p`
  snapshots of the asked scope and the declined confirmation, and the second views (the two
  `mend doctor` runs, `mend server status`, the container and volume listings). Record what the run
  removed in the report; that is the point of this feature.

## Gotchas

- `HOME` matters as much as `XDG_CONFIG_HOME`: the home scope edits `~/.ssh/config` under the real
  `HOME`. A run with the owner's `HOME` strips the owner's managed block.
- The home scope revokes the device on the effective CLI URL (`MEND_URL`, else the URL in
  `cli.json`), before deleting anything. Run it only when that server is one this run started and
  still answers; a server already removed makes the revocation fail, and the token then stays live
  until it is ended under Settings → Devices (a `kept · device token on <url>: …` line says so).
- When `cli.json` holds a token but no device id (a hand-written file, or one from an older CLI),
  the revocation is skipped without a word: no `revoked` line and no `kept` line
  (`apps/cli/src/uninstall.ts:417`). The token stays valid on the server while the file goes. A
  product gap: the plan does not say the token will outlive the uninstall.
- `--yes` is required without a terminal, and the confirmation reads stdin, not the scope flags. A
  plan-only check is `< /dev/null` without `--yes`: it prints the plan, removes nothing and exits
  `1`.
- `-y` is accepted as `--yes` (`apps/cli/src/uninstall.ts:49`), but `mend help uninstall` documents
  only `--yes`. A gap between the parser and the catalog.
- The plan line always names the `garage` container and `mend-garage` volume, even for an install
  from before the capture store; the removal then names only the volumes that install owns.
- Data volumes go only when their ownership label matches this installation's identity. Otherwise a
  `kept · volumes …: ownership could not be confirmed for this installation, so they stay` line
  names them. That is the designed outcome on a daemon that already had Mend data, not a failure.
- Workspace containers (`sealant-…`) carry no label tying them to this install; uninstall names them
  with the `docker rm -f` command and leaves them. Remove them by that command in cleanup.
- A `mend doctor --bundle` archive saved under the default `<config>/mend/bundles/` keeps the
  configuration directory: the home scope reports it as kept and does not remove it.
- With `--all` the device is revoked first (when a device id is saved), then the server goes, then
  the home files. If the server removal fails, the command exits `1` with the reason after removing
  the home files; read every `kept ·` line before retrying.
