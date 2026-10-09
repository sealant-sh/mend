# The CLI as a surface

The `mend` CLI explains itself from one catalog. `mend help` lists every command by section;
`mend help <command>`, `mend <command> --help` and `-h` print the same page; `mend man <command>`
opens it in `man`. A command used wrongly prints `usage:` with the same synopsis, an unknown command
says so and points at `mend help`, and every error goes to stderr as `mend: …` with exit code `1`.
`mend version` prints this CLI's version and the server's. `mend completions zsh|bash` prints a TAB
completion hook that completes commands and live session ids. A hidden `mend qr <text>` renders a
terminal QR code.

## Sub-features

- `help-index` prints `mend help`: every visible command by section, then the environment and files.
- `help-page` prints one command's page from `mend help <command>`, `mend <command> --help` or `-h`.
- `help-group` prints a family's pages in one list (`mend help service`).
- `help-alias` reaches the codex page from `mend help claude`, `opencode` or `pi`.
- `man-page` renders the same page as roff and opens it in `man`, or prints the text page without
  `man`.
- `usage-errors` quote the command's synopsis on a malformed call.
- `unknown-command` refuses an unknown first word and names `mend help`.
- `version` prints the CLI's and the server's versions and says when they differ.
- `completions` prints the zsh or bash hook; the hook asks the server for live session ids.
- `qr` renders a QR code for any text; it is kept out of the index.
- `bare-mend` opens the dashboard on a terminal and prints the index on a pipe.

## How to get to it (user POV)

- CLI: `mend help [command...]`, `mend <command> --help`, `mend <command> -h`, `mend --help`,
  `mend -h`.
- CLI: `mend man [command...]`; after a global npm install, `man mend` and `man mend-<command>`.
- CLI: `mend version`, `mend --version`, `mend -v`.
- CLI: `mend completions zsh|bash`.
- CLI: `mend qr <text>` (hidden).
- CLI: bare `mend` (the dashboard on a TTY, see [the dashboard](./tui.md); the index otherwise).
- Docs: `reference/cli` mirrors the catalog. Web, TUI, desktop, mobile, VS Code and Slack: not a
  surface for this feature.

## Driving it with verify

Preconditions:

- The `mend` CLI under test is on `PATH`. The help, man, usage, completions-hook and qr steps need
  no server. `version` and the completions' session list need `<web>` up and the CLI signed in, with
  at least one live session for the session list (for example
  `mend run --project <project> -- sleep 600` in its own PTY).
- Run every step with stdout captured to a file or pipe, except `mend man`, which runs with
  `MANPAGER=cat`.

- **Index.** Run `mend help`. The first line reads `mend · the agent workbench`. Section lines
  `start`, `sessions`, `services`, `project setup`, `organization` and `this machine` follow, each
  with one line per command and its summary. The index ends with `environment` (`MEND_URL`,
  `MEND_TOKEN`, `MEND_DETACH_KEY`) and `files` (`~/.config/mend/cli.json`, `~/.config/mend/keys/`).
  No line names `qr`. Exit code `0`. `mend --help` and `mend -h` print the same text.
- **One page, three ways.** Run `mend help doctor > a.txt`, `mend doctor --help > b.txt` and
  `mend doctor -h > c.txt`, then `diff a.txt b.txt` and `diff a.txt c.txt`. Both diffs are empty.
  The page starts `mend doctor · check this machine's setup, or bundle it for a bug report`, then
  `usage`, `  mend doctor`, `  mend doctor --bundle [--out <path>] [--tail <n>]`, and has
  `description`, `options`, `examples` and `see also` blocks.
- **Nested page.** Run `mend server setup --help`. It prints the `mend server setup` page, not the
  `mend server` page, and runs nothing.
- **Group.** Run `mend help service`. The first line reads `mend service · 8 commands`; the list
  names `service run`, `service add`, `service connect`, `service list`, `service logs`,
  `service restart`, `service stop` and `service init`; the last line reads
  `mend help service <subcommand> for one page`.
- **Alias.** Run `mend help claude`. The first line reads
  `mend codex · launch codex, claude, opencode or pi in a recorded worktree`, and the usage block
  holds `  also mend claude, mend opencode, mend pi, with the same options`.
- **No such page.** Run `mend help nope`. Stderr reads
  `mend: no command "nope" · mend help lists them`, exit code `1`.
- **Unknown command.** Run `mend nope`. Stderr reads
  `mend: unknown command "nope" · mend help lists them`, exit code `1`.
- **Usage errors quote the synopsis.** Run `mend completions`. Stderr reads
  `mend: usage: mend completions zsh|bash · e.g. mend completions zsh > "$fpath[1]/_mend"`, exit
  `1`. Run `mend stop --project <project>`. Stderr reads three lines:
  `mend: usage: mend stop [session-id-prefix]`, `       mend stop --all [--project <p>]` and
  `       mend stop --services [session-id-prefix]`, exit `1`. Both match the `usage` block of
  `mend help completions` and `mend help stop`.
- **Man.** Run `MANPAGER=cat mend man doctor`. `man` renders the page: a `NAME` section naming
  `mend-doctor` with the summary `check this machine's setup, or bundle it for a bug report`, then
  `SYNOPSIS`, `DESCRIPTION`, `OPTIONS`, `EXAMPLES` and `SEE ALSO`. Run `MANPAGER=cat mend man`. Its
  `NAME` section names `mend` with `the agent workbench`, and one section per catalog section
  follows. On a host with no `man` on `PATH`, the text page from `mend help doctor` prints instead.
  Run `mend man nope`. Stderr reads `mend: no command "nope" · mend help lists them`, exit `1`.
- **Version.** Run `mend version`. Line one reads `mend <cli version>`; line two reads
  `server <server version> · <web>`, followed by `versions differ — the server's API wins` when the
  two differ. `mend --version` and `mend -v` print the same lines. Run
  `MEND_URL=http://127.0.0.1:9 mend version`. Line two reads
  `server · unreachable · http://127.0.0.1:9`, exit code `0`, within about two seconds.
- **Completions hook.** Run `mend completions zsh`. Stdout starts `#compdef mend` and defines
  `_mend`. Run `mend completions bash`. Stdout ends `complete -F _mend mend`.
- **Live session ids complete.** With a live session, run
  `bash -c 'source <(mend completions bash); COMP_WORDS=(mend attach ""); COMP_CWORD=2; _mend; printf "%s\n" "${COMPREPLY[@]}"'`.
  It prints the live session's full id, the same id `mend sessions --json` lists. With
  `COMP_WORDS=(mend "")` and `COMP_CWORD=1` it prints the command words instead.
- **QR.** Run `mend qr https://example.com`. Stdout is a block of terminal QR characters, exit `0`.
  Run `mend qr`. Stderr reads `mend: usage: mend qr <text>`, exit `1`. Run `mend help qr`. It still
  prints `mend qr · render a QR code for the installer`.
- **Bare mend on a pipe.** Run `mend | head -1`. It prints `mend · the agent workbench`: on a
  non-terminal stdout bare `mend` and `mend ui` print the index instead of opening the dashboard.
- **Proof.** Keep each command's stdout, stderr and exit code, the two empty diffs, and the
  completion output with the session id beside the `mend sessions --json` line that names it.

## Gotchas

- `--help` or `-h` anywhere before `--` makes any command print its page and do nothing else:
  `mend land fix --help` lands nothing. After `--` it belongs to the user's command
  (`mend run -- cmd --help`). `help` itself is the exception (`apps/cli/src/main.ts:4920-4926`):
  `mend help --help` asks for a page named `--help` and prints
  `mend: no command "--help" · mend help lists them`, exit `1`.
- `mend <unknown> --help` prints `no command "<unknown>" · mend help lists them`, not the
  `unknown command` line: help runs first.
- Help pages wrap at the terminal width, capped at 100 columns. Compare pages produced at the same
  width, or on a pipe (80 columns).
- `mend man` runs `man -l` on a temporary file. BSD `man` on macOS has no `-l`; there the text page
  prints. Pass `MANPAGER=cat` in a harness so `man` does not wait for a pager. groff may print
  typographic dashes and quotes in a UTF-8 locale; match the man output on words, not bytes.
- `man mend` without the `mend` prefix needs the npm package installed globally (it ships `man/`). A
  CLI run from source has no installed man pages; report that path as unreachable, not failed.
- The completion hooks are a hand-written list that lags the catalog. The zsh command list and the
  bash word list (`apps/cli/src/main.ts:3862-3884`, `3915`) omit `login`, `logout`, `models`,
  `worktrees`, `workspace`, `secrets`, `dotfiles`, `env`, `ssh`, `invite`, `members`, `folder`,
  `operator`, `session`, `snake`, `man`, `version` and `completions`, and the server flag lists miss
  `--edge`, `--no-edge`, `--exposure`, `--tenancy` and `--keep-backups`. A product gap.
- The session list behind TAB is an undocumented internal command, `mend __complete session`
  (`apps/cli/src/main.ts:3842`), printing `id<TAB>harness · project · branch`. It swallows every
  error and prints nothing on a dead server; an empty completion is not proof of no sessions.
- `mend help qr` says the installer renders its pairing QR through `mend qr`
  (`apps/cli/src/help.ts:1394-1399`), but no installer in the repository calls it; the host
  installer was retired. Its only caller is the package smoke test
  (`apps/cli/scripts/test-package.mjs:126`). A stale description.
- `mend snake` reads `--no-tunnel` (`apps/cli/src/main.ts:5035-5036`), but its catalog entry has no
  options. A gap between the parser and the catalog.
- `mend version` never fails on a missing server; `server · unreachable` is a printed fact with exit
  code `0`.
