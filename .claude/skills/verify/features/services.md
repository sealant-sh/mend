# Services

A Service is a server running in a session's workspace that Mend supervises and makes reachable: its
output is recorded, its port is observed, and a user brings it to their own machine's loopback
through the Mend server, signed in as themselves. A user starts one from the session page's Services
card or with `mend service run`, adopts a port the agent already listens on, connects it with
`mend service connect`, and restarts or stops it. Services keep a workspace up after the agent
stops, and the session says so. The dashboard shows a session's Services and stops a held set; the
desktop has a Services sheet with the same verbs as the web card.

## Sub-features

- `service-run-web` starts a supervised Service from the session page's `+ run service…` form.
- `service-run-cli` starts one with `mend service run … -- <command>`, or a `mend.toml` Service by
  name.
- `service-recipe` runs a Service the worktree's `mend.toml` declares, from its `Run` button or
  `mend service <name>`.
- `service-add` adopts a port something in the workspace already listens on (`mend service add`, or
  the form with an empty command).
- `service-observe` shows each Service's observed state (`starting`, `running`, `reachable`,
  `unreachable`, `stopped`) and where it is reachable.
- `service-connect` tunnels live Services to this machine's loopback with `mend service connect`.
- `service-logs` replays and follows a Service's recorded output.
- `service-restart-stop` restarts a Service on the same port, or stops it and closes its tunnel.
- `service-hold` keeps the workspace up after the agent stops, and `Stop services` /
  `mend stop --services` ends that.
- `service-tui` shows the selected session's Services in the dashboard, tunnels its browser Services
  while it is selected, and stops a held set with `Shift+K`.
- `service-desktop` runs, adopts, opens, logs, restarts and stops Services from the desktop's
  Services sheet.

## How to get to it (user POV)

- Web: on a session page (`/sessions/<id>`), the `Services` card in the right column, and the
  `Stop services` button beside `Stop` while Services run.
- CLI:
  `mend service run [session] --port <port> [--name <n>] [--udp] [--http|--https] [--no-connect] -- <command...>`
  and `mend service run [session] <name> [--no-connect]` (shorthand `mend service <name>`).
- CLI: `mend service add [session] <port> [--name <n>] [--udp] [--http|--https]`,
  `mend service list`, `mend service connect [name...] [--port <p>]`,
  `mend service logs <name-or-id> [--from <sequence>]`, `mend service restart <name-or-id>`,
  `mend service stop <name-or-id>`, `mend service init [--yes]`.
- CLI: `mend attach`, `mend codex`, `mend claude` and the dashboard tunnel the attached session's
  `--http`/`--https` Services on their own; `mend stop --services [session]` stops them all.
- TUI: the dashboard's session pane lists the selected session's Services (two, then `+<n> more`).
  On a server that is not this machine, it tunnels that session's `--http`/`--https` Services while
  it stays selected (unless `mend ui --no-tunnel`). On a row whose agent stopped while Services keep
  the workspace up, `Shift+K` twice stops them.
- Desktop: a session tab's header button `Services <n>`, `Ctrl+Shift+S`, a Service's line under its
  session in the sidebar, or `Services` in the session row's right-click menu opens the side sheet
  `Session Services`. While Services hold a stopped session, its header has `stop services`, and the
  row's right-click menu has `Stop services`.
- Mobile, VS Code and Slack: no Services surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and the browser is signed in as the session's owner.
- A live session in `<project>`: run `mend run --project <project> -- sleep 1800` in its own PTY and
  note `<id>` and `<id8>` from its `✓ base … · session <id8>` line.
- `<serve-cmd>` is a command the workspace image can run that listens on TCP port `8000` and answers
  HTTP (for example `python3 -m http.server 8000`, if the image has `python3`). Launch must confirm
  which command the image supports.
- Local port `18000` is free on the machine running the CLI.
- The worktree declares no `mend.toml` Services, the project declares none, and the session has
  started no Service yet, so the Services card starts empty.
- TUI and desktop steps: the harnesses from [Start a session](./start-session.md).

- **Empty card.** Go to `<web>/sessions/<id>`. The `Services` card reads
  `none running · mend service run exposes one`.
- **Start from the CLI.** Run
  `mend service run <id8> --port 8000 --name web --http --no-connect -- <serve-cmd>`. Stdout shows
  `✓ Service web · <status>`, the address lines, and `  logs: mend service logs web`. Exit code `0`.
- **Observed on the web.** Without reloading, the `Services` card lists `web` with a status word,
  ending at `reachable` once the port answers. The session page shows `Stop services`.
- **List.** Run `mend service list`. One row reads `web` with status `reachable`, port `:8000` and
  the Service's short id, followed by where it is reachable from here.
- **Connect.** Run `mend service connect web --port 18000` in its own PTY. Stdout shows
  `● web → 127.0.0.1:18000 (tunnel to <web>)` and
  `  connections are authenticated as you · Ctrl-C stops`. Run
  `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/`. It prints `200`. Stop the
  connect with `Ctrl-C` in its PTY; the same curl then fails to connect, and the Service still reads
  `reachable`.
- **Logs.** Run `mend service logs web` in its own PTY. The recorded output replays from the start,
  then follows live. Stop with `Ctrl-C`.
- **Restart.** Run `mend service restart web`. The Service is the same name and port, and returns to
  `reachable`.
- **Start from the web.** Choose `+ run service…`. Run
  `await page.getByRole("button", { name: "+ run service…" }).click()`. The form opens with focus in
  its command input. Fill it:
  `await page.getByRole("textbox", { name: "pnpm dev (empty = adopt a listening port)", exact: true }).fill("<serve-cmd with port 8001>")`,
  `await page.getByRole("textbox", { name: "port", exact: true }).fill("8001")`,
  `await page.getByRole("textbox", { name: "name (optional)", exact: true }).fill("web2")`, and
  `await page.getByRole("combobox", { name: "Browser behavior" }).selectOption("http")`. Submit with
  the form's `Run` button, the one after `cancel` (see Gotchas). The button reads `Starting…`, then
  `web2` joins the card.
- **Stop one.** Run `mend service stop web2`. Stdout reads `✓ stopped · web2`. The card shows `web2`
  as ended, with a `Run` button to start it again.
- **TUI: Services in the session pane.** Run
  `tmux new-session -d -s mend-svc -x 200 -y 50 'mend ui'` and select the session (`h`/`l` between
  panes, `j`/`k` within one). The session pane's Services line reads
  `web :8000→<host port> reachable` (`web2` beside it while it runs), or, when the dashboard tunnels
  it here, the tunnel's own line, such as `web → http://localhost:<port>`. A session with none reads
  `no services running`.
- **Desktop: open the sheet.** Click the session's sidebar row (named
  `<harness> · <label or branch>`), then run
  `await page.getByRole("button", { name: /^Services \d+$/ }).click()` (or press `Control+Shift+S`).
  The side sheet `Session Services` opens
  (`const sheet = page.getByRole("complementary", { name: "Session Services" })`), headed `Services`
  with the session's label or branch. The sidebar's line for the Service is a button named
  `web reachable`.
- **Desktop: read a Service.** The row `web` reads `<declaration source> · :8000` and three facts:
  `Process running` (with its attempt), `Forward bound to <address>`, and `TCP accepted on :8000`
  with `observed <when>`. Its actions include `Logs`, `Restart` and `Stop`, plus `Open` and
  `Copy endpoint` when this desktop can reach the address, or `Copy command` (the
  `mend service connect` line) when it cannot.
- **Desktop: logs.** Scope to the article containing the exact Service name `web`, then run
  `await sheet.getByRole("article").filter({ has: page.getByText("web", { exact: true }) }).getByRole("button", { name: "Logs", exact: true }).click()`.
  A dialog named `web logs` opens (`page.getByRole("dialog", { name: "web logs" })`), titled
  `web · logs` with `read-only · sequence-addressed`, the recorded output, `Open as tab` and
  `Close`. `Open as tab` closes the dialog and the Services sheet, and opens a tab headed
  `web · logs · read-only · <branch>` with `close`.
- **Desktop: run or adopt.** Click the session's sidebar row again to return to its session tab,
  then run `await page.getByRole("button", { name: /^Services \d+$/ }).click()` to reopen
  `Session Services`. In the sheet's `One-off` form, run
  `await sheet.getByRole("textbox", { name: "command · leave empty to adopt a listening port" }).fill("<serve-cmd with port 8002>")`,
  `await sheet.getByRole("textbox", { name: "port", exact: true }).fill("8002")`,
  `await sheet.getByRole("textbox", { name: "name", exact: true }).fill("web3")`, choose `http` in
  the form's scheme select (no name; see Gotchas), and run
  `await sheet.getByRole("button", { name: "Run or adopt" }).click()`. It reads `Starting…`, then a
  `web3` row joins the sheet. A port outside 1–65535 reads `Enter a port between 1 and 65535.`
- **Desktop: restart and stop.** On the `web3` row, `Restart` reads `Restart…` and the row returns
  to `Process running`; `Stop` reads `Stop…`, then the row offers `Run again` (or `Remove forward`
  while its forward is still bound). `Close` closes the sheet. `Recipes` lists the worktree's
  `mend.toml` Services with `Run`, or `No recipes declared in mend.toml.`
- **Hold after the agent stops.** Run `mend stop <id8>`. Stdout reads
  `✓ stopped · <harness> · <id8> · <branch>`, then one line naming what keeps the workspace up,
  ending `· mend stop --services <id8>`, then `  review · <web>/sessions/<id>`. The session page
  shows a hold word in place of the status, and `web` stays `reachable`. The desktop tab's header
  shows the hold line and `stop services`.
- **Stop the Services.** Run `mend stop --services <id8>`. Stdout reads
  `✓ stopped 1 service · <harness> · <id8> · <branch>` (`services` when more than one).
  `mend service list` prints `no live services — mend service add <port> adopts a listening one`.
- **TUI: stop a held set.** Instead of `mend stop --services`, drive the dashboard: with the held
  session selected, run `tmux send-keys -t mend-svc K`. The status line reads
  `press ⇧K again to stop the services · <name> · <hold>`. Within five seconds run
  `tmux send-keys -t mend-svc K` again. It reads
  `stopped 1 service · <name> · the workspace ends once nothing is live` (`services` when more than
  one).
- **Desktop: stop a held set.** Instead, in the held session's tab, run
  `await page.getByRole("button", { name: "stop services", exact: true }).click()`. It reads
  `stopping services…`, then the hold line and the button leave the header.
- **Proof.** Capture the Services card with `web` reachable and after the stops:
  `await page.locator("body").ariaSnapshot()` and a screenshot. Keep the `mend service run`, `list`,
  `connect`, curl, `logs`, `stop` and `mend stop --services` transcripts with exit codes, the TUI
  session pane (`tmux capture-pane -p`) with `web` listed and after `Shift+K`, and the desktop sheet
  (`page.getByRole("complementary", { name: "Session Services" }).ariaSnapshot()`) with `web` listed
  and after the stops.

## Gotchas

- The `+ run service…` form's command, port and name inputs have no labels; their accessible names
  fall back to the placeholders `pnpm dev (empty = adopt a listening port)`, `port` and
  `name (optional)`. Playwright finds them by those names (pass `exact: true`: `port` is a substring
  of the command field's name), but the names change with the copy. The `udp` checkbox is named by
  its wrapping label. The missing labels are a finding.
- The card's title `Services` is a plain paragraph, and each Service row has no list or region role.
  Scope a row by its name text. Row actions (`Copy`, `Restart`, `Stop`) repeat per row and are faded
  until hover; Playwright still treats them as visible.
- `Run` names the form's submit button, each `mend.toml` recipe's start button and each ended
  Service's restart button. Scope it to the form or the row.
- A Service row's `Stop` shares its name with the session's own `Stop` button. Scope it to the row,
  or use `mend service stop <name>`.
- The endpoint line is a button named by its text (`:8000 → <address> …`), with the title
  `Copy <address>`; it copies, it does not open. `Open` is a link that appears only for a live,
  reachable Service declared `--http` or `--https` whose address this browser can use directly; a
  loopback-only address on a remote server shows the `mend service connect <name>` command instead.
- Against a remote server, `mend service run` without `--no-connect` keeps the terminal for a TCP
  Service, tunnelling the port, until `Ctrl-C`; against a local server, or for UDP, it returns. Use
  `--no-connect` in a scripted drive and connect in a separate PTY.
- `mend service run` needs a live session. A settled `mend run` session no longer has a workspace;
  keep one alive (`-- sleep 1800`) for the length of the recipe and stop it by id afterwards.
- `mend service connect` refuses a busy local port with
  `127.0.0.1:<port> is already in use here — pick one with: mend service connect <name> --port <n>`.
  Pick a free one rather than killing the holder.
- Status words are observations: `reachable` means a connection answered, not that the server works.
  Report them as written.
- The dashboard cannot start, restart, stop one, connect or log a Service; it shows them and stops a
  held set. Its status lines clear after five seconds, and the second `K` must land while the first
  one's line still shows.
- The desktop's `One-off` form has no labels: its command, port and name fields are named by their
  placeholders (`command · leave empty to adopt a listening port`, `port`, `name`), and its scheme
  select (`raw`, `http`, `https`) has no name at all
  (`apps/desktop/src/renderer/src/components/services-sheet.tsx:481`). Pick it by its options
  (`sheet.getByRole("combobox").filter({ hasText: "https" })`). The `udp` checkbox is named by its
  wrapping label. Those are findings.
- The desktop's Service rows are `article` elements with no name, and their actions (`Open`,
  `Copy endpoint`, `Logs`, `Restart`, `Stop`) repeat per row. Scope by the row's name text. The
  sheet's `Close` shares its name with the Land sheet's and the logs dialog's `Close`.
- The desktop's header buttons are lowercase (`stop`, `stop services`); pass `exact: true`, since
  Playwright's name match is otherwise case-insensitive and partial.
- Without control of the session, the desktop sheet keeps only reading actions and reads
  `Only this session's owner runs Services in it, unless they share control.`; a steerer who may not
  type in the workspace reads `Only <owner> starts Services in this workspace.` and has no form.
