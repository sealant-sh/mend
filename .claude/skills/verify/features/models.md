# Models

The server owns one model catalog per harness: each model's id and label, the harness's default,
and the efforts a model takes when they are fewer than the harness's. Every client offers that one
list (`mend models`, the web and desktop composers' model and settings menus, the phone's chips,
VS Code's quick picks) and preselects the server's default. A launch sends the chosen model,
effort and speed; the server resolves a missing model to the default, keeps an effort within what
the model takes, and records what the session was started with. The CLI's human session listing,
web session facts and desktop terminal header show the model and any recorded effort. Web project
rows and mobile session rows and headers show the model without effort. TUI rows show the harness
without model or effort; VS Code tree rows omit model and effort. A resume keeps the recorded
model; a resume on another harness clears it.

## Sub-features

- `models-list` prints the catalog per harness, the default marked (`mend models [--json]`).
- `launch-flags` starts a session on a chosen model, effort and speed
  (`--model`, `--effort`, `--fast`).
- `web-picker` picks the model from the composer's model menu, and effort and speed from its
  settings menu.
- `desktop-picker` does the same in the desktop launcher.
- `mobile-picker` picks model, thinking and priority chips under each harness row.
- `vscode-picker` picks model and thinking in `Mend: New Session…`'s quick picks.
- `model-shown` shows model and recorded effort in the CLI's human listing, web session facts
  and desktop terminal header; web project rows and mobile rows and headers show model only.
  TUI rows show harness only, and VS Code tree rows omit model and effort.
- `resume-with` resumes a settled session on another harness (`mend resume --with`), which clears
  the recorded model.

## How to get to it (user POV)

- CLI: `mend models [--json]`; `mend claude|codex|opencode|pi … --model <id>`. Claude and Codex
  take `--effort <level>`, and pi takes it as thinking; opencode's launch ignores effort.
  `--fast` requests priority processing for Codex only. `mend resume [session-id] --with <harness>`;
  `mend sessions` shows `· <model> · <effort>` when those facts were recorded.
- Web: the Now page's `New session` composer: the harness pill, the model pill (named by the
  model's label), and the settings pill (named `settings` or by its summary) with `Thinking`,
  `Speed`, `Permissions` and `Land when a turn completes`. Narrow composers fold them into one
  `options` pill. The session page's facts line and the project page's worktree tree show the
  model.
- Desktop: the launcher (the sidebar's `New session in <project>` button) with the same pills; the
  terminal pane's header shows the model.
- Mobile: the Projects tab, under each project, one row per harness (`claude`, `codex`). Opening
  a row shows `model` chips only with catalog entries, `thinking` only with several effort choices,
  `base` only with fetched branches, and `priority` only when the catalog reports `fastCapable`
  (Codex; Claude has none). Session rows and the session header show model without effort.
- VS Code: `Mend: New Session…` asks `Harness`, then `Model`, then `Thinking`, then `Permissions`.
  The session tree omits model and effort; it shows harness only in the fallback label when a
  session has no label. Not drivable yet: no VS Code driver exists in the verify stack.
- Slack: `model=` in a mention (see [Slack](./slack.md)). Not drivable yet: no Slack driver exists
  in the verify stack.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI are signed in, `<project>` is adopted with a
  worktree `<worktree>`, and `mend connect claude` has been run (see
  [Start a session](./start-session.md) for the composer's project and worktree pickers).
- From `mend models`, `<default-id>` and `<default-label>` are claude's default model, and
  `<model-id>` and `<label>` another claude model. The browser has no saved composer choice for
  `<project>` (a fresh browser profile).
- `mend resume` reads the project from the current directory: run it inside a clone of
  `<repo-url>` whose `origin` is `<repo-url>`. Resuming `--with codex` needs `mend connect codex`.
- `app` is the desktop window's page over CDP, signed in to `<web>`, and `phone` the Expo web page
  at 390x844, paired with `<web>` (see [Pair a device](./pairing-devices.md)). The mobile chips
  step needs a fixture with only `<project>` visible in Projects, catalog entries for Claude and
  several effort choices. With several projects, report that step blocked by the missing
  project-scoped harness handle.

- **List.** Run `mend models`. Stdout shows one block per harness: a line `<harness>  effort <range>`
  (with ` · --fast` where the harness offers priority processing), then one line per model:
  `  <id>  <label>`, with `default` on the default and `effort <range>` where a model takes fewer.
  Exit `0`.
- **List as JSON.** Run `mend models --json`. Stdout is `{ "version": 1, "harnesses": [ … ] }`;
  each harness has `harness`, `models` (`id`, `label`, `isDefault`, `efforts`), `defaultModel`,
  `efforts` and `fastCapable`. The ids match the text listing.
- **Launch on a model.** Run
  `mend claude "List the files and change nothing." --worktree <worktree> --project <project> --model <model-id> --effort high --detach`.
  Exit `0`. Run `mend sessions --project <project>`: the new row ends its dim facts with
  `· <model-id> · high`.
- **Bad effort.** Run `mend claude --worktree <worktree> --project <project> --effort turbo -d`.
  Stderr reads `mend: --effort must be one of low, medium, high, xhigh, max, ultra`, exit `1`, and
  nothing starts.
- **Effort the model does not take.** Launch a codex session (with `mend connect codex`) on a model
  whose `mend models` line lists fewer efforts, with `--effort ultra`. `mend sessions` shows an
  effort from that model's range, not `ultra`.
- **Web picker.** Run `await page.goto("<web>/")`, pick `<project>` and `<worktree>` in the
  composer, and make sure the harness pill reads `claude`. The model pill is named by the selected
  model's label, the default's on a fresh browser: run
  `await page.getByRole("button", { name: "<default-label>", exact: true }).click()`. A menu opens
  whose `menuitemradio` rows list every claude model; the default's row reads
  `<default-id> · default` and reports `aria-checked="true"`. Run
  `await page.getByRole("menuitemradio", { name: new RegExp("<model-id>") }).click()`. The menu
  closes and the pill reads `<label>`; reopened, that row reports `aria-checked="true"`.
- **Effort and speed.** Open the settings pill (named `settings` when nothing is chosen) and run
  `await page.getByRole("menuitemradio", { name: "high", exact: true }).click()`. The row reports
  `aria-checked="true"` and, after `Escape`, the pill reads `high`. For codex, the same menu holds
  `Standard` and `Fast 1.5× · more usage`.
- **Start and read the record.** Fill the prompt
  (`page.getByRole("textbox", { name: "What should the session do?" })`) and choose `Start`. On the
  session page the facts line starts with `<model-id> · high · <branch> · worktree <worktree>`.
  The project page's worktree tree shows `claude · <model-id>` on that session's line.
- **Sticky choice.** Reload `/` and pick the same project and worktree. The model pill still reads
  `<label>` and the settings pill `high`: the composer keeps the choice per project and harness on
  this browser.
- **Desktop picker.** Run
  `await app.getByRole("button", { name: "New session in <project>" }).click()`. A dialog named
  `New session in <project>` opens. Its model pill is named by the model's label; choosing a
  `menuitemradio` changes it as on the web. After `Start`, the terminal pane's header shows
  `<model-id> · <effort>` (an effort only when one was chosen).
- **Mobile chips.** With the single-project fixture, in the phone (390x844), run
  `await phone.getByRole("tab", { name: "Projects" }).click()`, then
  `await phone.getByText("claude", { exact: true }).click()`. The row opens `model` chips, one per
  catalog model by label, `default` beside the default, and `thinking` chips when there are
  several effort choices. `base` appears after branches are fetched; Claude has no `priority`
  group. Its summary line under `claude` reads the chosen model's label. With several projects,
  stop before the text click and report the missing project-scoped handle.
- **Resume on another harness.** Stop the session from "Launch on a model" (`mend stop <id8>`),
  then, inside the clone, run `mend resume <id8> --with codex` in its own PTY. Stdout shows
  `✓ resuming claude · <id8> as codex` and `  watch · <web>/sessions/<id>`. Detach with `Ctrl+]`, then run
  `mend sessions --project <project> --all`: that row no longer shows `· <model-id>`.
- **Proof.** Save `await page.getByRole("menu").ariaSnapshot()` with the model menu open, and the
  session page's ariaSnapshot and screenshot with its facts line visible. Keep the `mend models`,
  `mend models --json`, launch, `mend sessions` and `mend resume` transcripts with exit codes.

## Gotchas

- The web composer's prompt textarea has no label; Playwright names it only from the placeholder
  `What should the session do?`. That is a missing-label finding.
- The composer's pills have no stable accessible name: the model pill is named by the current
  model's label, the settings pill by its summary (`settings`, `high`, `high · ask`, …), the harness
  pill by the harness. Ask for the name the current state implies. That is a finding.
- The menu (`role="menu"`) has no name, and its group titles (`Thinking`, `Speed`, `Permissions`,
  `Land when a turn completes`) are plain text, not `group`s. A `menuitemradio`'s name is its label
  and its note together (`Fable · latest fable · default`); match the id with a regular expression.
- The model and settings pills render only when the composer is at least medium width; a narrow
  composer shows a single `options` pill holding `Model` and the settings groups. Keep the default
  viewport.
- `mend sessions --json` carries no `model` or `effort` field; only the human listing shows them.
  Assert on the text listing (or the web session page). That is a product gap against the models
  decision that every client shows the model.
- TUI session rows omit model and effort, VS Code tree rows omit both, and mobile rows and
  headers omit effort. VS Code's tree also omits harness when a session has a label, but its
  fallback label includes harness. These are display gaps against the recorded-model decision.
- The web session page shows the model's id, not its label; the composer shows the label.
- `--fast` affects Codex only. opencode's launch ignores effort even when a choice was recorded.
- An id the catalog does not list is passed through to the harness as given; the harness decides
  whether it exists. A failed launch for that reason is the harness's word, not Mend's.
- opencode lists models but names no default, so a launch with no `--model` records no model and
  leaves the choice to opencode's own configuration.
- The catalog is a table an operator edits; there is no write surface. Read ids from `mend models`
  rather than hardcoding them.
- `mend resume` has no `--project` flag. Outside a clone of the project it fails with
  `no adopted project matches <cwd> — run "mend adopt" here first, or name one with --project`,
  whose advice does not apply to `resume`. It attaches the terminal: run it in its own PTY.
- The phone's harness rows and chips have no roles, and each row's `Start` is a role-less
  `EvButton` named only `Start`: with `claude` and `codex` rows (and one set per project) the run
  cannot tell them apart. The `getByText("claude", { exact: true })` step is unambiguous only
  with one project visible. There is no project-scoped accessible harness handle; with several
  projects report the chips step blocked by that missing handle. That is a finding; start phone
  sessions from the session recipes, not by these buttons.
- The TUI dashboard has no model picker: its launches run the server's default.
