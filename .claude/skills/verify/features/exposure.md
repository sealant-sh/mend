# Exposure, the gates and budgets

The operator declares how the instance is reached with `MEND_EXPOSURE`: `loopback`, `private` (the
default: a network they control admission to) or `public`. Mend cannot observe who can reach it, so
it reports what it observed beside what was declared, item by item, and never a verdict. The public
exposure gate is that report: thirteen items, each `observed`, `carried`, `declared` or `open`. Only
`public` refuses to start, and only while an item this build can observe is open. The multi mode gate
does the same for `MEND_TENANCY=multi`. Budgets bound what a client, an account or an organization may
ask: reaching one refuses new work and stops nothing that runs. Credentials that must ride a URL ride
as upgrade tickets: single use, thirty seconds, one target.

## Sub-features

- `exposure-report` prints the declaration and every public gate item with how it was established
  (`mend operator exposure`).
- `tenancy-gate` prints the multi mode gate item by item (`mend operator gate`).
- `health-counts` answers `/api/health`, unauthenticated, with the declaration and counts only.
- `doctor-line` prints one `exposure` line in `mend doctor` (mapped in [doctor.md](./doctor.md)).
- `shell-line` shows `exposure · <declared> · <scheme>` in the web sidebar.
- `public-refusal` refuses to start `MEND_EXPOSURE=public` with the open items and the fix for each.
- `declared-items` takes `core-private` and `edge-tls` in `MEND_EXPOSURE_DECLARED` and refuses any
  other name at start.
- `budget-refusal` refuses new work past a budget with `budget reached · <limit> <what> · nothing running was stopped`.
- `upgrade-tickets` mints a single-use, thirty-second ticket for a socket URL.
- `url-bearers` accepts and logs, or refuses, a bearer in a socket URL (`MEND_URL_BEARERS`).

## How to get to it (user POV)

- CLI: `mend operator exposure` and `mend operator gate` (operator only).
- CLI: `mend doctor` prints the `exposure` line; `mend server status` prints the declared posture
  beside what it observed, and, for the operator, both gates (mapped in [server.md](./server.md)).
- CLI: `mend server setup --exposure <loopback|private|public>` and `--tenancy <single|multi>`
  declare the posture on the Docker install (mapped in [server.md](./server.md)).
- Web: the sidebar's machine block, at widths of 1024 px and more, reads
  `exposure · <declared> · <http|https>` and `· via proxy` when the request came through a trusted
  proxy.
- HTTP: `GET <web>/api/health` (no sign-in) carries `exposure` and `tenancyGate`.
- Every surface meets a budget as a refusal of the request that crossed it; every first-party
  client mints upgrade tickets on its own.
- Server: `MEND_EXPOSURE`, `MEND_EXPOSURE_DECLARED`, `MEND_EXPOSURE_REASSESSED`, `MEND_URL_BEARERS`,
  `MEND_TENANCY` and the `MEND_BUDGET_*` variables, read at start
  (`apps/docs/src/content/docs/reference/server-environment.md`).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` with `MEND_EXPOSURE` and `MEND_TENANCY` unset (`private`, `single`).
  The default CLI is signed in as the operator (the first account). `<member>` (CLI at
  `XDG_CONFIG_HOME=/tmp/verify-member`) is any other account.
- The run may restart the instance with changed server variables through the stack Launch made,
  and restores them at the end. Never change the owner's own instance.
- `<project>` is adopted. `mend connect claude` is done for the budget step, or use `mend run`.

- **Health counts.** Run `curl -s <web>/api/health`. The JSON has `"tenancy": "single"`,
  `"tenancyGate": { "passed": …, "failing": [ … ] }`, `"upgradeTickets": true` and
  `"exposure": { "declared": "private", "open": <n>, "unobservable": <m> }`, and names no exposure
  item.
- **Exposure report.** Run `mend operator exposure`. Line 1 reads
  `exposure · declared private · reached over a network you control admission to`. Thirteen lines
  follow, one per item (`https-origin`, `secure-cookies`, `trusted-proxies`, `enrollment-closed`,
  `tenancy-gate`, `budgets`, `no-bearers-in-urls`, `browser-headers`, `error-redaction`,
  `executor-channel-transport`, `core-private`, `edge-tls`, `reassessment`), each starting with `●`
  observed, `◐` carried, `○` declared or `·` open, then the word, the detail and, after ` · `, what
  would close or observe it where the item names one. The last line reads
  `<k> of 13 items open · <b> this build can observe; MEND_EXPOSURE=public refuses to start · <u> it cannot`,
  or `… · 0 this build can observe · <u> it cannot` when only unobservable items are open. Exit
  code `0`. `core-private`, `edge-tls` and `reassessment` read `open` until declared.
- **Gate.** Run `mend operator gate`. Ten lines, one per multi mode gate item
  (`cross-organization-authorization` through `operator-present`), each `✓` or `·`, then the detail
  and, where the item names one, its fix. The last line reads `<k> of 10 items open; MEND_TENANCY=multi refuses to start`, or
  `every item is in place; MEND_TENANCY=multi may start`. The ids after `·` match
  `tenancyGate.failing` from `/api/health`.
- **Operator only.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend operator exposure`. Exit code `1`,
  stderr `mend: this account is not the operator of this Mend`.
- **Sidebar line.** At a 1280x800 viewport, go to `<web>/`. The text
  `exposure · private · <http|https>` is visible in the sidebar
  (`page.getByText(/^exposure · private · /)`).
- **Declare an item.** Restart with `MEND_EXPOSURE_DECLARED=edge-tls`. `mend operator exposure`
  shows `○ edge-tls  declared …`. Restart with `MEND_EXPOSURE_DECLARED=budgets`: the server does not
  start, and its log says
  `MEND_EXPOSURE_DECLARED names budgets: only core-private and edge-tls can be declared; every other item is observed by this process or not at all.`
- **Public is refused while observable items are open.** Restart with `MEND_EXPOSURE=public` on
  an `http` origin. The server does not start; its log starts with
  `MEND_EXPOSURE=public is refused: the public exposure gate`, lists each open item as
  `<id>: <detail> (<fix>)`, and ends
  `Start with MEND_EXPOSURE=private behind a network you control admission to, or close them.`
  Restart without it and confirm `/api/health` answers.
- **Budget refuses new work, stops nothing.** Restart with `MEND_BUDGET_ACCOUNT_LIVE_SESSIONS=1`.
  Start one live session:
  `mend claude "List the files and change nothing." --name verify-budget-1 --project <project> --detach`.
  Then run
  `mend claude "List the files and change nothing." --name verify-budget-2 --project <project> --detach`.
  Exit code `1`, stderr
  `mend: budget reached · 1 unsettled sessions for one account · nothing running was stopped`.
  `mend sessions --project <project>` still lists `verify-budget-1` live. `mend operator exposure`
  still reads `budgets` as observed (a positive number is set).
- **A budget off is a gate item.** Restart with `MEND_BUDGET_ACCOUNT_TERMINALS=0`.
  `mend operator exposure` shows `· budgets  open …`.
- **Upgrade ticket.** With the CLI's saved token `<token>` (from `$XDG_CONFIG_HOME/mend/cli.json`,
  default `~/.config/mend/cli.json`) and a live session `<id>`, run
  `curl -s -X POST <web>/api/upgrade-tickets -H "Authorization: Bearer <token>" -H "content-type: application/json" -d '{"target":"tty-embed","session":"<id>"}'`.
  The JSON has `ticket` and `"expiresInSeconds": 30`. Run it with `{"target":"service-tunnel"}`:
  status `400`, with the message `a service-tunnel ticket needs service`.
- **Bearer in a URL.** Restart with `MEND_URL_BEARERS=refuse`. Run
  `curl -si "<web>/api/tty?session=<id>&token=<token>" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="`.
  Status `400`, body
  `a bearer in the URL is refused; mint an upgrade ticket (POST /api/upgrade-tickets)`.
  `mend operator exposure` shows `no-bearers-in-urls` as `observed`. With the default (`accept`),
  the server log shows `a bearer arrived in a URL; this client predates upgrade tickets` with the
  value redacted.
- **Proof.** Keep the `/api/health` body, both `mend operator` transcripts before and after each
  restart, the server log lines of each refused start, the budget refusal transcript beside the
  `mend sessions` that still lists the first session, and the curl transcripts. Restore every
  variable, restart, stop `verify-budget-1`, and keep the artifacts.

## Gotchas

- The report never says an instance is fit to expose, and neither may a verification report.
  Write what was declared and what was observed (`declared private · 5 of 13 items open`), never a
  verdict about the instance or the gate (AGENTS.md, "Access nouns", lists the phrases a report
  never uses). `nothing open · every item was observed here, is carried by this build, or was
  declared by the operator` is a statement about the list.
- `loopback` and `private` never refuse to start; they change only the report. Only `public` is
  refused, and only for items this build can observe. `core-private`, `edge-tls` and `reassessment`
  never block a start.
- `/api/health` gives counts for exposure but names the failing multi mode gate items in
  `tenancyGate.failing` (an open question in ADR 0004, left as released).
- The sidebar's exposure line is a plain paragraph in the `lg` sidebar
  (`apps/web/src/components/shell.tsx:186-191`); below 1024 px it is not rendered. Its `title`
  holds the host's address kinds. It has no role or name; use `getByText`.
- `mend operator exposure` and `mend operator gate` have no `--json`. Assert lines by their item id.
- Budget request windows are in memory per API process; a restart resets them. Session ceilings are
  counted from the database and can be overshot by the number of requests in flight.
- A budget refusal answers `429` with `budget`, `limit`, `retryAfterSeconds` and `message`. The
  CLI prints the message only. Ceilings have no retry time: they free when the account's own work
  settles.
- The bearer-in-URL check runs before the upgrade; the exact status of a plain GET without upgrade
  headers was not read from source. Send the upgrade headers as above.
- `MEND_TENANCY=multi` refuses to start while any gate item is open, with
  `MEND_TENANCY=multi is refused: the multi mode gate …`; `MEND_TENANCY=single` refuses while more
  than one organization exists. A run in `single` never sees the multi refusal unless it restarts
  with `multi`.
- Upgrade tickets are spent by one use and expire after thirty seconds; a ticket in a proof artifact
  is already dead, but redact it anyway.
- The coverage table lists exposure as CLI only; the web sidebar line and `/api/health` are also
  user-visible.
