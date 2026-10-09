# Services

A Service is a server running in a session's workspace that Mend supervises and makes reachable: its
output is recorded, its port is observed, and a user brings it to their own machine's loopback
through the Mend server, signed in as themselves. A user starts one from the session page's Services
card or with `mend service run`, adopts a port the agent already listens on, connects it with
`mend service connect`, and restarts or stops it. Services keep a workspace up after the agent
stops, and the session says so.

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
- Desktop: the `Services` sheet. Mobile and VS Code: not a Services surface in this map. Not driven
  by this map.

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
- **Hold after the agent stops.** Run `mend stop <id8>`. Stdout reads
  `✓ stopped · <harness> · <id8> · <branch>`, then one line naming what keeps the workspace up,
  ending `· mend stop --services <id8>`, then `  review · <web>/sessions/<id>`. The session page
  shows a hold word in place of the status, and `web` stays `reachable`.
- **Stop the Services.** Run `mend stop --services <id8>`. Stdout reads
  `✓ stopped 1 service · <harness> · <id8> · <branch>` (`services` when more than one).
  `mend service list` prints `no live services — mend service add <port> adopts a listening one`.
- **Proof.** Capture the Services card with `web` reachable and after the stops:
  `await page.locator("body").ariaSnapshot()` and a screenshot. Keep the `mend service run`, `list`,
  `connect`, curl, `logs`, `stop` and `mend stop --services` transcripts with exit codes.

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
