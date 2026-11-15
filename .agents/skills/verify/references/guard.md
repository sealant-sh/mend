# The guard

Every `mend` a run starts, and every driver, passes `scripts/guard/`. Read this when the guard
refuses something (exit 97), or before adding a driver. In this file, Launch is
`pnpm verify stack up` and Cleanup is `pnpm verify stack down`. `$E` is the run's evidence
directory, `$P` its private directory, `$wt` its outer worktree and `$web` its tunnel;
`.verify/stack/current.json` names each for the run that is up.

**A verifier never talks to the owner's server; the guard refuses it.** `scripts/guard/mend` stands
in front of the CLI, and `scripts/guard/policy.mjs` decides for it and for every driver. A run may
reach two servers: the outer one it declared (`MEND_VERIFY_OUTER_URL`), and its own stack through
its own tunnel (`http://localhost:<port>` or `http://127.0.0.1:<port>`, while `$P/tunnel.json` says
`tunnel.mjs` saw its own child bind that port and the recorded pid is still that child, and nothing
listens on `[::1]:<port>`). A loopback URL alone is not enough: the owner's own server, or the
owner's own `mend service connect stack --port 3305`, may listen on this machine, so
`tunnel.mjs start` refuses a port anything already holds. The guard refuses (exit 97, before any
request) when:

- `MEND_VERIFY_OUTER_URL` is not declared, `MEND_TOKEN` is set, or `MEND_URL` is (except
  `http://127.0.0.1:9`, loopback's discard port, where the map drives the unreachable-server lines);
- `XDG_CONFIG_HOME` is unset, relative or missing, `$XDG_CONFIG_HOME/mend/cli.json` is missing (the
  CLI then reads a legacy `~/.mend`; only `mend login --url <one of the two>` may make it, into an
  existing `$XDG_CONFIG_HOME/mend`), or the config is this machine's own (under `~/.config/mend` or
  `~/.mend`, for `$HOME` and for the account's home in the password database, symlinks resolved, so
  setting `HOME` elsewhere changes nothing, and under `$MEND_VERIFY_MACHINE_XDG`, recorded at
  Launch), the same file (a hard link), or a copy holding the same token or device id (read to
  compare, never printed): a run's CLI config is its own;
- that config, or a `--url` or `--server` argument (`mend login --url …` included), names any other
  server. Only the words after a runner's `--` (`mend run`, `mend service`,
  `mend claude|codex|opencode|pi`) are left alone: they run in the workspace;
- the command acts on this machine's own Mend installation (`mend server …`, `mend uninstall`),
  except its help page: those recipes run on a disposable host;
- `MEND_VERIFY_REAL_MEND` names a Mend session's in-workspace helper (`/run/mend/bin/mend`, which
  every workspace links to `/usr/local/bin/mend`), or a script that starts it: the helper ignores
  the config and acts on the session it runs in, not on the run's stack;
- the command is `mend connect github` without `--from-stdin` (or `--remove`, or its help): the CLI
  would run `gh auth token`, which reads this machine's GitHub login.

Then it becomes the real CLI (`$MEND_VERIFY_REAL_MEND`, else this checkout's `apps/cli` from source;
never a `mend` from `PATH`, which inside a session is that helper), with no `MEND_SESSION_*`
variable, and with `XDG_CONFIG_HOME` pinned to the absolute, resolved directory it checked, so no
change of directory or of `HOME` downstream makes the CLI read another config. The CLI gets a home
of the run's own (`~/.cache/mend-verify/home/<digest>`, with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`GH_CONFIG_DIR` in it) and none of this machine's session, SSH agent, GitHub or provider variables
(`GH_TOKEN`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, …): `mend connect github`, `--use-my-login`,
`memory import`, `dotfiles sync`, `skills push` and `ssh setup` see an empty home, never the owner's
logins or files. Nor the keyring: `gh auth token` finds a login in the OS keyring through the
session D-Bus even with an empty home, so the CLI gets no D-Bus, keyring agent or password manager
variable (`DBUS_*`, `GNOME_KEYRING_*`, `KWALLET*`, `GPG_AGENT_INFO`, `SSH_AGENT_PID`, `OP_*`,
`BW_SESSION`), a session bus address that names no socket, and a runtime directory of its own. A
recipe that needs a login supplies a test one, through the secret registry and `--from-stdin`
(`fakes.mjs` holds the skill's fake ones: [recipes.md](recipes.md)). The drivers hold to the same
policy: `drive-tui.sh` puts the guard first on its terminal's `PATH` and its bundled CLI behind it,
and `drive-tui.sh`, `drive-desktop.sh`, `drive-web.mjs` and `drive-mobile.mjs` refuse a `<web>` that
is not the run's tunnel (`drive-web.mjs` also takes the mobile proxy `drive-mobile.mjs` started in
front of it or, with `--outer`, in front of the declared outer: [surfaces.md](surfaces.md)). The box
is an outer server only when its operator says so: then declare its URL. An alias or a shell
function named `mend` outranks `PATH` and skips the guard (an interactive zsh often has one), so run
any step you write by hand in a `bash` script, where aliases do not apply, or `unalias mend` first.
The helpers start `mend` through `PATH`, so they always meet the guard.
