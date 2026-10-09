# Replace a workspace that shares one home

With per-person workspaces (ADR 0016, on by default), each person who runs anything in a workspace
runs as their own Linux user. A workspace that started with one shared home, as every workspace
started before Mend 0.36 did, keeps it until it is replaced. Once the worktree's next launch would
run per person, Mend marks that workspace to retire: it takes only its launcher's sessions and turns,
and every session in it says so. Mend replaces it on its own when nothing would stop. Otherwise the
change's owner reads what was checked and what would stop, and chooses `Replace this workspace now`
on the session page or `mend workspace replace` in a terminal. The replacement ends nothing that was
not on the list the owner saw; when more would stop by then, the server refuses and stops nothing.

## Sub-features

- `retire-line` shows the retirement line on the session page and under the session in
  `mend sessions`.
- `retire-evidence` lists what was checked, and when, and one line per thing that would stop.
- `replace-web` replaces from the session page's `Replace this workspace now` button.
- `replace-cli` replaces with `mend workspace replace <session>`, asking `[y/N]` or taking `--yes`.
- `replace-refused` refuses, in the server's words, when the list changed since it was read or an
  agent turn is in flight.
- `replacing-line` shows that the workspace is being replaced, and that nothing new starts until it
  has been saved and replaced.

## How to get to it (user POV)

- Web: on a session page (`/sessions/<id>`), a note under the header with the retirement line, the
  list `What would stop`, and, for the change's owner, the button `Replace this workspace now`.
- CLI: `mend sessions` prints the retirement line under each live session in that workspace, and for
  the owner `Replace this workspace now · mend workspace replace <id8>` with the evidence lines.
- CLI: `mend workspace replace <session> [--yes]`; `<session>` is a prefix of the session id.
- Desktop and mobile carry the same action (`Replace this workspace now`); mobile asks through a
  native alert that does nothing on the web build. Not driven by this map.
- TUI, VS Code, Slack: no entry point.

## Driving it with verify

Preconditions:

- The server runs with `MEND_HARNESS_LAYOUT` unset or `person` (the default). Mend looks for
  workspaces to retire only then.
- A live session `<id>` whose workspace shares one home and is marked to retire, signed in as the
  owner of its worktree's first session (`<id8>` is its id prefix). Per the docs, a worktree's live
  shared-home workspace is marked when the worktree's next launch would run per person, and that
  happens only once a per-person workspace has run on the same image. Two ways to reach it: a
  session left live across an upgrade from a release before 0.36, or a worktree whose first launch
  ran with a shared home because the image's capability was not known yet. Launch must produce this
  state; a fresh instance has none, and a run without it reports every step unreachable with
  "no workspace waiting to be replaced".
- Something in that workspace would stop, so Mend does not replace it on its own: an open shell
  (`mend shell <id8>` in its own PTY) is enough.

- **Session line in the CLI.** Run `mend sessions`. Under the session's row, one line reads
  `This workspace started before Mend 0.36 and shares one home · it takes only <name>'s sessions and turns until it is replaced`
  (`This workspace shares one home · …` for a workspace started on 0.36 or later), followed by
  `Replace this workspace now · mend workspace replace <id8>` and indented evidence: a `Checked: …`
  or `Checked at HH:MM UTC: …` line, one line per thing that would stop (for example `shell`), and
  `Mend starts the launching session's mend.toml Services again.` Exit code `0`.
- **Session page.** Go to `<web>/sessions/<id>`. The same retirement line is shown, the list
  `page.getByRole("list", { name: "What would stop" })` holds the stop lines, and
  `page.getByRole("button", { name: "Replace this workspace now" })` is present.
- **Decline in the CLI.** Run `mend workspace replace <id8>` in a PTY and answer `n` to
  `replace it? [y/N]`. Stdout shows the retirement line, `Replace this workspace now?`, the evidence
  lines, then `nothing replaced`. Exit code `0`. `mend sessions` still shows the retirement line.
- **Non-interactive without --yes.** Run `mend workspace replace <id8> < /dev/null` from a non-TTY
  harness. Stderr reads `mend: non-interactive · pass --yes to replace the workspace`; exit code
  `1`.
- **Refused after a change.** Open a second shell (`mend shell <id8>` in another PTY) after the
  page loaded, then choose `Replace this workspace now` on the page:
  `await page.getByRole("button", { name: "Replace this workspace now" }).click()`. An alert
  (`page.getByRole("alert")`) states the server's refusal, for example
  `What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.`,
  and the list reloads with both shells.
- **Replace.** Run `mend workspace replace <id8> --yes`. Stdout ends with
  `✓ Replacing this workspace so that each person runs as themselves · nothing new starts until it has been saved and replaced · <harness> <id8>`.
  Exit code `0`. The open shells end.
- **Second view.** Reload `<web>/sessions/<id>`. The note reads the replacing line, then goes once
  the workspace has saved and been replaced. `mend sessions` no longer prints the retirement line
  under the session.
- **Proof.** Capture the session page with the retirement note and the `What would stop` list
  (`ariaSnapshot()` and a screenshot), and again after the replacement. Keep the `mend sessions` and
  every `mend workspace replace` transcript with its exit code.

## Gotchas

- This state does not exist on a fresh instance by default. Report its absence as an unmet
  precondition, never as a pass.
- Only the change's owner sees `Replace this workspace now` on the web and the `mend workspace
  replace` line in `mend sessions`. Anyone else reads the retirement line and what would stop, with a
  process's or container's name withheld.
- The web button replaces at once; there is no confirmation step on the web. The desktop asks in a
  dialog titled `Replace this workspace now?`. The CLI asks `replace it? [y/N]`.
- `mend workspace replace` with no replacement waiting still asks the server, which refuses in its own
  words; the CLI prints them after `mend: ` and exits `1`.
- An agent turn in flight is never stopped: the server refuses the replacement the same way, and
  nothing is stopped.
- Mend checks the workspace about once a minute. A list read before a new shell or process appeared
  is stale; the refusal is the expected outcome, not a failure.
- Mend replaces the workspace on its own when nothing would stop, so a workspace with no shell,
  terminal agent, hand-started Service, unknown process or running container may be replaced before
  the run gets to it.
- The retirement note and the `What would stop` list have no heading or region role. Scope by the
  list name and the button name.
