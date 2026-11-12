# Shared control

By default only a session's owner steers it: sends turns, answers approvals, interrupts, and sends
review comments back. Everyone else who can see the project reads the record and reviews the change.
The owner can turn on shared control for one session from the session page, the desktop terminal
pane or `mend session share`. Turning it on asks first, in words true to whose login a steered turn
spends: the sender's own in a per-person workspace, the owner's in a workspace that shares one home.
While it is on, the others see `runs as <owner> · shared control on`, and every act is recorded with
who did it. The terminal stays the owner's: others read it and their keys are dropped. The owner, or
an organization owner, turns it off.

## Sub-features

- `share-on-web` turns shared control on from the session page's `Shared control` group, through the
  `Turn on shared control?` dialog.
- `share-off-web` turns it off with `Off`; nothing is asked.
- `share-cli` turns it on or off with `mend session share <session> on|off [--yes]`.
- `share-refused` refuses a non-owner, a script without `--yes`, and opencode sessions.
- `viewer-lines` tells everyone else who steers: `Only <owner> steers this session. …` while off,
  `runs as <owner> · shared control on` while on.
- `org-owner-off` lets an organization owner who does not own the session turn it off with
  `Turn off`.
- `terminal-owner-only` keeps typing, shells and commands with the owner: a steerer's terminal is
  read-only, with the owner's name.
- `who-pays` says whose login a steered turn spends, beside the switch and in the dialog.
- `audit` records `shared control of session <id>` and `turned off shared control of session <id>`.

## How to get to it (user POV)

- Web: the session page (`/sessions/<id>`), under the header lines: the label `Shared control` and
  the group of `Off` and `On` for the owner; a line and `Turn off` for an organization owner; the
  line `Only <owner> steers this session. You can read the record and review the change.` for
  everyone else while it is off.
- CLI: `mend session share <session> on|off [--yes]`. `<session>` is a prefix of the session id.
- Desktop: the terminal pane's header strip shows the same `Shared control` group for the owner, and
  a strip with `<owner> shares control of this session.` and `Turn off`, or
  `Only <owner> steers this session. …`, for everyone else.
- Mobile: the session screen (`/session/<id>`) reads
  `only the owner steers this session · you can read it and review the change` for a viewer who
  cannot steer, and, while control is shared, the terminal's read-only line. No switch.
- Slack: an `@mend` follow-up in a thread from someone other than the owner is a steered turn,
  refused unless shared control is on (`not drivable yet`: no Slack workspace in the verify stack).
- VS Code and the TUI offer no switch.

## Driving it with verify

Preconditions:

- Two accounts in one organization, as built in [organization.md](./organization.md): `<owner>`
  (organization owner, browser `page`, default CLI) and `<member>` (browser `memberPage`, CLI with
  `XDG_CONFIG_HOME=/tmp/verify-member`).
- `<project>-shared` is a `shared` project both can see.
- `<member>` has `mend connect claude` against this instance; `<owner>` has too. The sessions below
  are live Claude terminal sessions.
- `<member>` starts the session under test, so that `<owner>` can also act as organization owner:
  `XDG_CONFIG_HOME=/tmp/verify-member mend claude "List the files and change nothing." --name verify-share --project <project>-shared --detach`.
  Note `<id8>` from its `  attach · mend attach <id8>` line and `<id>` from `mend sessions --json`.

- **Viewer line while off.** On `page` (`<owner>`), go to `<web>/sessions/<id>`. The text
  `Only <member> steers this session. You can read the record and review the change.` is visible,
  the header line ends `· runs as <member>`, and the left pane is `Record` with
  `run <run> · the owner's terminal; the record updates as the session runs`.
- **Refuse a script.** Run
  `XDG_CONFIG_HOME=/tmp/verify-member mend session share <id8> on < /dev/null`. Exit code `1`,
  stderr `mend: non-interactive · pass --yes to turn shared control on`.
- **Refuse a non-owner.** Run `mend session share <id8> on --yes` as `<owner>`. Exit code `1`,
  stderr `mend: only the session owner can share control of this session`.
- **Owner's switch.** On `memberPage`, go to `<web>/sessions/<id>`. The label `Shared control` and
  the group are present; `Off` reports `aria-pressed="true"`. The line beside it states whose login
  a steered turn spends (see Gotchas).
- **Ask, then keep it off.** Run
  `await memberPage.getByRole("group", { name: "Shared control" }).getByRole("button", { name: "On", exact: true }).click()`.
  A dialog named `Turn on shared control?` opens
  (`memberPage.getByRole("dialog", { name: "Turn on shared control?" })`). Run
  `await memberPage.getByRole("button", { name: "Keep it off" }).click()`. The dialog closes and
  `Off` is still pressed.
- **Turn it on.** Click `On` again, then
  `await memberPage.getByRole("button", { name: "Turn on", exact: true }).click()`. The button reads
  `Turning on…`, the dialog closes, and `On` reports `aria-pressed="true"`.
- **Steerer's view.** Reload `page`. The header line ends `· runs as <member> · shared control on`,
  the `Only <member> steers …` line is gone, and the left pane is `Terminal`, headed
  `run <run> · live · read-only`, above the line
  `This session runs in a terminal. Only <member> types here; they can continue it as a conversation.`
  Keys typed into it reach nothing.
- **Organization owner turns it off.** On `page`, the text
  `<member> shares control of this session.` is visible. Run
  `await page.getByRole("button", { name: "Turn off" }).click()`. It reads `Turning off…`, then the
  line returns to `Only <member> steers this session. …`.
- **CLI on and off.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend session share <id8> on --yes`.
  Stdout `✓ shared control on · claude <id8>` and the who-pays line. Exit code `0`. Run
  `XDG_CONFIG_HOME=/tmp/verify-member mend session share <id8> off`. Stdout
  `✓ shared control off · claude <id8>`, nothing asked. Exit code `0`.
- **CLI ask in a terminal.** In tmux (`tmux new-session -d -s verify-share -x 200 -y 50`), send
  `XDG_CONFIG_HOME=/tmp/verify-member mend session share <id8> on` and Enter. The pane shows
  `Turn on shared control?`, the dialog's body, and `turn on? (n: keep it off) [y/N]`. Send `n` and
  Enter: the pane shows `shared control stays off`.
- **opencode is refused.** If `<member>` has an opencode session `<oc8>`, run
  `XDG_CONFIG_HOME=/tmp/verify-member mend session share <oc8> on --yes`. Exit code `1`, stderr
  `mend: opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.`
- **Desktop.** Sign the desktop app in as `<member>`, the session's owner: the switch renders only
  for the owner (`apps/desktop/src/renderer/src/components/terminal-pane.tsx:396`). Attach over CDP
  and open `<member>`'s session as a terminal pane (see [desktop.md](./desktop.md); `win` is the
  window's page from `chromium.connectOverCDP`), then run
  `await win.getByRole("group", { name: "Shared control" }).getByRole("button", { name: "On", exact: true }).click()`.
  An alert dialog named `Turn on shared control?` opens
  (`win.getByRole("alertdialog", { name: "Turn on shared control?" })`) with `Keep it off` and
  `Turn on`. Choose `Turn on`; `On` reports `aria-pressed="true"`. Turn it off with `Off`. Signed in
  as `<owner>` instead, the same pane shows no group, but a strip reading
  `Only <member> steers this session. You can read the record and review the change.` while off, and
  `<member> shares control of this session.` with `Turn off` while on.
- **Mobile.** Run the Expo app on the web (`pnpm --filter @mend/mobile web`, written `<mobile-web>`)
  in a 390x844 Playwright context, paired as `<owner>` (see
  [pairing-devices.md](./pairing-devices.md) and [mobile.md](./mobile.md)). With shared control off,
  go to `<mobile-web>/session/<id>`. The text
  `only the owner steers this session · you can read it and review the change` is visible
  (`mobile.getByText("only the owner steers this session · you can read it and review the change")`).
  Turn shared control on as `<member>` (CLI step above) and reload: that line is gone and, while the
  agent runs, the terminal reads
  `This session runs in a terminal. Only <member> types here; they can continue it as a conversation.`
  Capture `ariaSnapshot()` and a screenshot of both states.
- **Second view.** Reload `page` (`<owner>`) on `/sessions/<id>`: the header line matches the last
  state set. In `<web>/settings`, the `Audit log` lists `<member> shared control of session <id>`,
  `<owner> turned off shared control of session <id>` and
  `<member> turned off shared control of session <id>`.
- **Proof.** Capture `/sessions/<id>` for both accounts while off and while on (`ariaSnapshot()` and
  a screenshot with the header lines visible), the open dialog, the audit log, and every
  `mend session share` transcript with its exit code. Stop the session with
  `XDG_CONFIG_HOME=/tmp/verify-member mend stop <id8>` at the end.

## Gotchas

- The line beside the switch, the dialog's body and the CLI's second line depend on the worktree's
  layout. Where each person runs as themselves (per-person homes, the default):
  `Each turn runs on its sender's login. From now until this session ends, the agent uses no one's personal memory or instructions. The conversation so far, including what your agent loaded before, becomes visible to whoever steers.`
  That is also the whole dialog body in that layout. Where the workspace shares one home, the line
  beside the switch and the CLI's second line read
  `Each turn runs on your provider logins and Git access, whoever sends it.`, and only in that
  layout does the dialog body prefix it with
  `Everyone who can see this project can send turns, answer approvals and interrupt.`
  (`packages/domain/src/workbench/shared-workspace.ts:84-86`). Assert the wording the layout
  implies; see [per-person-homes.md](./per-person-homes.md).
- `On` needs `exact: true`: Playwright's name match is a substring match by default.
- The web page has no box to send a turn. A steered turn comes from a conversation session on the
  desktop or the phone, from Slack, or as review comments sent back
  ([send-review-back.md](./send-review-back.md)). In a terminal session the owner alone sends
  comments back and resumes. A steerer without a login for the provider is refused
  `Connect Claude to steer this session.` there.
- `mend session share` matches only a prefix of the session id, not a worktree name.
- No CLI read shows whether shared control is on: `mend sessions` and its `--json` omit it
  (`apps/cli/src/main.ts:4455`, `main.ts:4551`). The web session page and the audit log are the
  second views. That is a product gap.
- The header facts (`runs as <owner> · shared control on`), the viewer lines and the terminal's
  read-only line are plain text, not `role="status"`. Assert them with `getByText`. On mobile they
  are unlabelled `Text` elements; assert their text.
- The desktop switch keeps `On` disabled with `session view not read yet` until the session view has
  answered; wait for it before clicking.
- An organization owner never sees `On`: only the session's owner turns it on. `Turn off` appears
  for an organization owner only while control is shared.
- Mobile shows who steers and the read-only terminal line but has no switch; VS Code shows the
  shared-workspace and waiting lines only.
- Removing a session's owner from the organization turns shared control off on their sessions before
  they stop, and records it in each session's control log as `shared-control-off` by the owner who
  removed them; nobody keeps steering on the removed account's logins.
