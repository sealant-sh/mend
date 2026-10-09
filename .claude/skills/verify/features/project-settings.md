# Project settings

A project's Setup tab holds its policy switches: whether its sessions run in the background,
which review automation Mend runs when a session settles (`Description & tour`, `Suggest fixes`,
`Name the session`), and whether a session lands after a completed turn (`Land when a turn completes`). Each reads `inherit`, `on` or `off`; `inherit` follows the organization's default,
which follows the instance's. Owners also set the project's visibility (`private` or `shared`) and
remove it. The defaults live in Settings: the organization's `Defaults · <organization>` panel for
its owners, and the instance's `Sessions`, `Review automation` and `Landing` panels for the
operator only.

## Sub-features

- `settings-background` sets `Run sessions in the background` per project (`inherit`/`on`/`off`).
- `settings-review-automation` sets `Description & tour`, `Suggest fixes` and `Name the session`
  per project.
- `settings-landing` sets `Land when a turn completes` per project.
- `settings-visibility` makes a project `private` or `shared` (owners only).
- `settings-remove` removes the project and its store copy with a two-step confirm.
- `settings-org-defaults` lets owners pick `Instance · <on|off>`, `On` or `Off` per switch for the
  organization; members read the value and its source.
- `settings-instance-defaults` lets the operator set the instance's `On`/`Off` for each switch.

## How to get to it (user POV)

- Web: a project's Setup tab, sections `Visibility` (owners, anchor `#visibility`), `Sessions`
  (`#sessions`), `Review automation` (`#review`), `Landing` (`#landing`), and the
  `Remove project…` button at the bottom (`#remove`; owners, or the creator of a private project).
- Web: `/settings`, panel `Defaults · <organization>` (anchor `#organization-defaults`), and under
  `instance · operator` the panels `Sessions`, `Review automation` and `Landing`.
- CLI: no command sets these. Launches read them: `mend codex|claude … --land|--no-land`,
  `--foreground`, `--detach`; `mend adopt --private|--shared` picks visibility at adoption only.
- Desktop: the launcher's landing choice per session (see [Land a change](./land-change.md)).
  TUI, mobile, VS Code: no surface. Slack: the `Landing` setting's `off` also covers sessions
  started from Slack (see [Slack](./slack.md)).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the instance's first account (operator and
  organization owner), and `<project>` was adopted by that account.
- Every project switch reads `inherit` and the organization follows the instance for every switch
  (`Instance · on`/`Instance · off` is pressed in each row of `Defaults · <organization>`).
- The CLI steps need `mend connect claude`.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`
  and, for one row inside a section,
  `const row = (s, label, button) => s.locator("div").filter({ has: page.getByText(label, { exact: true }) }).filter({ has: page.getByRole("button", { name: button, exact: true }) }).last()`.

- **Read the switches.** Open `<project>`'s Setup tab. `section("Sessions")` shows
  `Run sessions in the background` with buttons `inherit`, `on`, `off`. `section("Review automation")` shows rows `Description & tour`, `Suggest fixes` and `Name the session`, each with
  `inherit`, `on`, `off`. `section("Landing")` shows `Land when a turn completes` with `inherit`
  reporting `aria-pressed="true"`.
- **Landing off.** Run
  `await section("Landing").getByRole("button", { name: "off", exact: true }).click()`. `off`
  reports `aria-pressed="true"`. Reload: it still does.
- **The project wins over `--land`.** Run
  `mend claude "List the files and change nothing." --name verify-land-off --project <project> --land --detach`.
  After `✓ worktree verify-land-off · branch <branch>` stdout reads
  `· automatic landing · off for <project> · the project's setting wins over --land`. Stop it with
  `mend stop <id8>`. Set `Landing` back to `inherit`; the same launch with `--land` (another
  `--name`) then reads
  `✓ automatic landing · on for this session · from this terminal, land with mend land`.
- **Background off.** Run
  `await section("Sessions").getByRole("button", { name: "off", exact: true }).click()`. Start
  `tmux new-session -d -s fg -x 200 -y 50 'mend claude "List the files and change nothing." --name verify-fg --project <project>'`,
  wait until `mend sessions --project <project> --json` lists `verify-fg` live, then
  `tmux kill-session -t fg`. `mend sessions --project <project> --all --json` shows that session
  settled: the launching `mend` exited, so it stopped. Set `Sessions` back to `inherit` and repeat
  with `--name verify-bg`: after `tmux kill-session` the session stays live. Stop it with
  `mend stop <id8>`.
- **Review automation.** Run
  `await row(section("Review automation"), "Name the session", "off").getByRole("button", { name: "off", exact: true }).click()`.
  The row's `off` takes the chosen style; no attribute reports it (see Gotchas). Set it back to
  `inherit`.
- **Organization default.** Go to `<web>/settings`. `section("Defaults · <organization>")` has
  five rows: `Run sessions in the background`, `Compose the description & tour`, `Suggest fixes`,
  `Name the session`, `Land when a turn completes`, each with `Instance · on|off`, `On`, `Off`
  (all with `aria-pressed`). Run
  `await row(section("Defaults · <organization>"), "Land when a turn completes", "Off").getByRole("button", { name: "Off", exact: true }).click()`.
  `Off` reports `aria-pressed="true"` in that row. Choose that row's `Instance · …` again to
  restore it.
- **Instance default.** Under `instance · operator`, `section("Landing")` shows
  `Land when a turn completes` with `On` and `Off` (both with `aria-pressed`); `section("Sessions")`
  and `section("Review automation")` show `On`/`Off` per row. Read them; change them only on a
  disposable instance, and restore them.
- **Visibility.** On the project's Setup tab, run
  `await page.getByRole("group", { name: "Visibility" }).getByRole("button", { name: "shared" }).click()`.
  `shared` reports `aria-pressed="true"`. Choose `private` to restore it.
- **Remove the project.** Use a disposable project (`mend adopt <repo-url> --name <project>-rm --auth ambient`). On its Setup tab run
  `await page.getByRole("button", { name: "Remove project…" }).click()`. The button now reads
  `Really remove project and store copy?` and the line
  `Stops live sessions, deletes sessions and reviews, and removes the store copy. The origin repository is untouched.`
  appears. Run
  `await page.getByRole("button", { name: "Really remove project and store copy?" }).click()`. It
  reads `Removing…`, then the browser lands on `/projects`. `mend projects` no longer lists
  `<project>-rm`.
- **Proof.** ARIA snapshots and screenshots of `section("Landing")` before and after `off`, of the
  `Defaults · <organization>` panel, and of the remove confirmation; the `mend claude` launch
  transcripts with the automatic landing lines; the `mend sessions --all --json` output for
  `verify-fg` and `verify-bg`; the `mend projects` output after removal.

## Gotchas

- The `Sessions` and `Review automation` choice buttons on the Setup tab expose no state: no
  `aria-pressed`, only a style (`apps/web/src/components/project-setup.tsx:365-379`, `485-499`).
  The instance's `Sessions` and `Review automation` `On`/`Off` buttons in Settings have the same gap
  (`apps/web/src/routes/settings.tsx:597-611`, `655-669`). Only `Landing`, `Visibility` and the
  organization defaults report `aria-pressed`. A screenshot is the only read-back for the others.
- `inherit`, `on` and `off` repeat in every row and section of the Setup tab (`Dotfiles` and
  `Dependencies` use `on`/`off` too), and `On`/`Off` repeat across Settings panels. Rows have no
  group role; scope by section and row as above, and pass `exact: true`.
- The labels differ by place: `Description & tour` on the Setup tab, `Compose the description & tour` in Settings.
- `Remove project…` disarms when it loses focus. Click the armed button directly, without
  focusing anything in between. Removal stops every live session in the project, teammates'
  included, and cannot be undone; never run it on a project the run did not create.
- Only owners see `Visibility`; only owners, or the creator of a private project, see
  `Remove project…`. Members who do not manage the project see neither the switches nor the
  sections; they read `How sessions here launch is set by the project's creator or an organization owner. You can start sessions and review changes as it stands.`
- The instance panels render only for the operator; anyone else sees no editors there, not
  refusing ones.
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
