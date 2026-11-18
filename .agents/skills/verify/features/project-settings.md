# Project settings

A project's Setup tab holds its policy switches: whether its sessions run in the background, which
review automation Mend runs when a session settles (`Description & tour`, `Suggest fixes`,
`Name the session`), and whether a session lands after a completed turn
(`Land when a turn completes`). Each reads `Inherit · <value>`, `On` or `Off`; `Inherit` follows the
session owner's own switch (SLNT-1155: nothing comes from the organization or the instance any
more). Owners also set the project's visibility (`private` or `shared`) and remove it. Each person
sets their own switches in Settings (`Sessions`, `Review`, `Landing`), as plain `On`/`Off` with no
Inherit. The organization's `Defaults · <organization>` panel holds only `Where new sessions run`.

## Sub-features

- `settings-background` sets `Run sessions in the background` per project (`Inherit`/`On`/`Off`).
- `settings-review-automation` sets `Description & tour`, `Suggest fixes` and `Name the session` per
  project.
- `settings-landing` sets `Land when a turn completes` per project.
- `settings-visibility` makes a project `private` or `shared` (owners only).
- `settings-remove` removes the project from listed projects while retaining its files and history.
- `settings-retention` restores a removed project or purges it with name confirmation.
- `settings-own-automation` lets each person turn their own switches `On` or `Off` (Settings →
  Sessions, Review, Landing); `GET /api/me/automation` answers `{ own, effective }`, the same plain
  values, and a `PUT` with a `null` is refused with 400 `AutomationInheritRemoved`.
- `settings-org-defaults` lets owners pick where the organization's new sessions run; it no longer
  shows automation switches (the organization's are stored but not read).
- `settings-instance-defaults` is gone: `/settings/instance/defaults` redirects to Instance ·
  Environment.

## How to get to it (user POV)

- Web: a project's Setup tab, sections `Visibility` (owners, anchor `#visibility`), `Sessions`
  (`#sessions`), `Review automation` (`#review`), `Landing` (`#landing`), and the `Remove project…`
  button at the bottom (`#remove`; owners, or the creator of a private project).
- Web: `/settings/sessions`, `/settings/review` and `/settings/landing` for your own switches;
  `/settings`, panel `Defaults · <organization>` (anchor `#organization-defaults`).
- CLI: no command sets these. Launches read them: `mend codex|claude … --land|--no-land`,
  `--foreground`, `--detach`; `mend adopt --private|--shared` picks visibility at adoption only.
- Desktop: the launcher's landing choice per session (see [Land a change](./land-change.md)). TUI,
  mobile, VS Code: no surface. Slack: the `Landing` setting's `off` also covers sessions started
  from Slack (see [Slack](./slack.md)).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the instance's first account (operator and organization
  owner), and `<project>` was adopted by that account.
- Every project switch follows (its `Inherit · on`/`Inherit · off` is pressed): it then shows the
  signed-in person's own value.
- The CLI steps need `mend connect claude`.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`
  and, for one row inside a section,
  `const row = (s, label, button) => s.locator("div").filter({ has: page.getByText(label, { exact: true }) }).filter({ has: page.getByRole("button", { name: button, exact: true }) }).last()`.

- **Read the switches.** Open `<project>`'s Settings tab, `Landing` sub-tab
  (`<web>/projects/<id>/settings/landing`). Under the heading `Sessions`, the group
  `page.getByRole("group", { name: "Run sessions in the background" })` holds the buttons
  `Inherit · <on|off>` (the value it resolves to), `On` and `Off`; under `Landing`, the group
  `Land when a turn completes` holds the same three, `Inherit · off` reporting `aria-pressed="true"`
  on the box (17 Nov). On the `Review` sub-tab, under `Review automation`, the groups
  `Compose the description and tour`, `Suggest fixes` and `Name the session` each hold
  `Inherit · …`, `On`, `Off`, one pressed.
- **Landing off.** Run
  `await page.getByRole("group", { name: "Land when a turn completes" }).getByRole("button", { name: "Off", exact: true }).click()`.
  `Off` reports `aria-pressed="true"`. Reload: it still does.
- **The project wins over `--land`.** Run
  `mend claude "List the files and change nothing." --name verify-land-off --project <project> --land --detach`.
  After `✓ worktree verify-land-off · branch <branch>` stdout reads
  `· automatic landing · off for <project> · the project's setting wins over --land`. Stop it with
  `mend stop <id8>`. Set `Landing` back to `Inherit · …`; the same launch with `--land` (another
  `--name`) then reads
  `✓ automatic landing · on for this session · from this terminal, land with mend land`.
- **Background off.** Run
  `await page.getByRole("group", { name: "Run sessions in the background" }).getByRole("button", { name: "Off", exact: true }).click()`.
  Start
  `tmux new-session -d -s fg -x 200 -y 50 'mend claude "List the files and change nothing." --name verify-fg --project <project>'`,
  wait until `mend sessions --project <project> --json` lists `verify-fg` live, then
  `tmux kill-session -t fg`. `mend sessions --project <project> --all --json` shows that session
  settled: the launching `mend` exited, so it stopped. Choose that group's `On` and repeat with
  `--name verify-bg`: after `tmux kill-session` the session stays live. Stop it with
  `mend stop <id8>` and choose `Inherit · …` again. A positive case using `Inherit` instead requires
  the person's own background switch to be on.
- **Review automation.** Run
  `await page.getByRole("group", { name: "Name the session" }).getByRole("button", { name: "Off", exact: true }).click()`.
  `Off` reports `aria-pressed="true"` (see Gotchas). Choose `Inherit · …` again.
- **Your own switches.** Go to `<web>/settings/landing`. `Land when a turn completes` is one switch
  (`role="switch"`, `aria-checked`), with no Inherit. Flip it; reload: it stays. On a project whose
  `Landing` is `Inherit`, the choice now reads `Inherit · <your value>` and its tip says
  `From your own settings`. Flip it back. `/settings/review` holds
  `Compose the description and tour`, `Suggest fixes` and `Name the session`; `/settings/sessions`
  holds `Run sessions in the background`.
- **Organization default.** Go to `<web>/settings/organization/defaults`. Under the heading
  `Defaults · <organization>` one group: `Where new sessions run` with `Inherit · <runtime>`,
  `Docker`, `Boat`. No automation switch is shown. `/settings/instance/defaults` lands on Instance ·
  Environment.
- **Visibility.** On the project's Setup tab, run
  `await page.getByRole("group", { name: "Visibility" }).getByRole("button", { name: "shared" }).click()`.
  `shared` reports `aria-pressed="true"`. Choose `private` to restore it.
- **Remove the project.** Use a disposable project (`mend adopt <repo-url> --name <project>-rm`). On
  its Setup tab run `await page.getByRole("button", { name: "Remove project…" }).click()`. The
  button now reads `Remove project? It can be restored.` and explains that files and history are
  kept, with restore at Projects → Removed projects. Click the armed button. The browser lands on
  `/projects`; the listed-project directory omits it. Expand Removed projects and click Restore
  within its `article`. Reload: the project is listed again. Purge is a separate action requiring
  its exact name. Shared projects require an organization owner; private projects require their
  creator. The full retention drive, CLI commands and evidence are in
  [T3 gateway → Restorable project removal](./t3-gateway.md#restorable-project-removal). Observed
  2026-10-30 for `st-verify-retention-control`:
  `/var/tmp/t3s1-retention-verify.3CxTpp/evidence/web/remove-control/`, captures
  `web-removal-confirm`, `web-removed-control` and `web-restored-control`.
- **Proof.** ARIA snapshots and screenshots of `section("Landing")` before and after `Off`, of the
  `Defaults · <organization>` panel, and of the remove confirmation; the `mend claude` launch
  transcripts with the automatic landing lines; the `mend sessions --all --json` output for
  `verify-fg` and `verify-bg`; the `mend projects` output after removal.

## Gotchas

- The project's switches are on the Settings tab's `Landing` and `Review` sub-tabs, each a `group`
  named by its label with `Inherit · <value>`, `On` and `Off` (box ARIA snapshots, 17 Nov). The
  project and your own Settings name the row `Compose the description and tour`. The steps that
  click `Off`/`On` and reload were not driven on the box.
- Every project and organization choice reported `aria-pressed` on the box (17 Nov). `On` and `Off`
  repeat in every group: scope to the group by its name and pass `exact: true`. The `section` and
  `row` helpers above are no longer needed for these choices.
- `Remove project…` disarms when it loses focus. Click the armed button directly, without focusing
  anything in between. Removal stops every live session in the project, teammates' included, and
  cannot be undone; never run it on a project the run did not create.
- Only owners see `Visibility`; only owners, or the creator of a private project, see
  `Remove project…`. Members who do not manage the project see neither the switches nor the
  sections; they read
  `How sessions here launch is set by the project's creator or an organization owner. You can start sessions and review changes as it stands.`
- `Run sessions in the background` applies to CLI launches only: a browser tab closing cannot
  promise a stop. `--detach` and `--foreground` on a launch override it.
- `Land when a turn completes` lands only after turns Mend runs itself, and terminal sessions never
  land by themselves. The CLI line is the observable proof of the setting, not a landing.
- Review automation passes need inference ("Mend uses inference"); with no provider connected their
  effects cannot be observed, only the stored choice.
- `components/project-setup-facts.tsx` defines a setup facts rail and a `Setup sections` index whose
  comments say the project page and the Setup tab render them, but no route renders either. A
  product gap: the Setup tab has no index; its sections are reachable only by scrolling or by the
  anchors above.
