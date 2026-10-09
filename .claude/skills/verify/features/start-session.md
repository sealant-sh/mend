# Start a session

A session is one supervised conversation with a coding agent, or one command of the user's own, in a
git worktree of an adopted project. A user starts one from the Now page's composer, from a
worktree's `New session` menu, or with `mend codex`, `mend claude` or `mend run`. Mend records
everything it does and opens the session's page, where its status reads as an observation ("Running
· recording", "Completed · observed").

## Sub-features

- `start-composer` starts a session from the Now page composer: project, worktree, harness, prompt.
- `start-new-worktree` creates a worktree from the `New worktree` dialog, from the project page or
  from inside the composer's worktree picker.
- `start-in-worktree` starts another session in an existing worktree from its `New session` menu.
- `start-cli-harness` launches `mend codex` or `mend claude` in a named worktree, attached or
  detached.
- `start-cli-run` runs any command as a session with `mend run` and returns when it settles.
- `session-page` shows the session's status, terminal or record, checkpoints, and the way to its
  review.
- `session-stop` stops the agent; the record and the review remain.

## How to get to it (user POV)

- Web: the Now page (`/`) shows a `New session` composer once a project exists.
- Web: on a project's Worktrees tab (`/projects/<id>`), the `New worktree` button, and each
  worktree's `New session` menu.
- Web: a session card or row on the Now page, or a session line under its worktree, opens
  `/sessions/<id>`.
- CLI: `mend codex`, `mend claude`, `mend opencode` and `mend pi` (one command, four harnesses):
  `["prompt"] [--name <worktree>] [--worktree <existing>] [--model <id>] [--effort <level>] [--base <ref>] [--ask] [--fast] [--detach|-d] [--foreground] [--no-tunnel] [--land|--no-land] [--project <p>]`.
- CLI: `mend run [--project <p>] -- <command...>`.
- CLI: `mend sessions`, `mend worktrees`, `mend attach`, `mend stop`, and the dashboard (`mend ui`,
  or bare `mend`).
- Mobile: the Now and Project screens open a session. Desktop: its launcher and sidebar open every
  live session as a terminal. VS Code: `Mend: New Session…` and
  `Mend: New session in this worktree…`. Not driven by this map.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in, and `<project>` is adopted (see
  [Adopt a project](./adopt-project.md)).
- For the harness steps, `mend connect claude` (or `codex`) has been run against this instance. The
  `mend run` steps need no provider.
- No worktree named `verify-web`, `verify-run` or `verify-claude` exists in `<project>`
  (`mend worktrees --project <project>`).

- **Create a worktree.** Open the project and choose `New worktree`. Run
  `await page.getByRole("link", { name: new RegExp("^<project>") }).click()` from `/projects`, then
  `await page.getByRole("button", { name: "New worktree" }).click()`. A dialog named `New worktree`
  opens with focus in the textbox `Name`.
- **Name it and create.** Run
  `await page.getByRole("textbox", { name: "Name" }).fill("verify-web")`. The line under it reads
  `branch mend/verify-web`. Run
  `await page.getByRole("button", { name: "Create worktree" }).click()`. The dialog closes and the
  Worktrees list shows `verify-web`.
- **Start a session in it.** Open the worktree's menu and pick a harness. Run
  `await page.getByRole("button", { name: "New session in verify-web" }).click()`, then
  `await page.getByRole("menuitem", { name: "claude" }).click()`. The browser lands on
  `/sessions/<id>`, whose heading starts with `claude`, and a status word appears: `Starting`, then
  `Running · recording`.
- **Start from the composer.** Go to `/`. Run `await page.goto("<web>/")`. The form `New session` is
  present (`page.getByRole("form", { name: "New session" })`). Run
  `await page.getByRole("combobox", { name: /^Project: / }).click()`,
  `await page.getByRole("combobox", { name: "Search projects" }).fill("<project>")`, then
  `await page.getByRole("option", { name: new RegExp("^<project>") }).click()`. The trigger now
  reads `Project: <project>`.
- **Pick the worktree.** Run `await page.getByRole("combobox", { name: /^Worktree: / }).click()` and
  `await page.getByRole("option", { name: /^verify-web/ }).click()`. The trigger reads
  `Worktree: verify-web` and the `Start` button is enabled.
- **Prompt and start.** Run
  `await page.getByRole("textbox", { name: "What should the session do?" }).fill("List the files in this repository and change nothing.")`,
  then `await page.getByRole("button", { name: "Start", exact: true }).click()`. The button reads
  `Starting…`, then the browser lands on a new `/sessions/<id>`.
- **Session page.** On the session page, the status reads `Running · recording` while the agent
  runs, the `Terminal` pane attaches, and the `Checkpoints` list shows one line per checkpoint as
  `<ordinal> · <trigger>` (or `none yet`). The link `Review the change`
  (`page.getByRole("link", { name: "Review the change" })`) and the button `Mark checkpoint` are
  present.
- **Stop.** Run `await page.getByRole("button", { name: "Stop", exact: true }).click()`. The button
  reads `Stopping…`; with no live Services the status then reads `Stopped` (while Services keep the
  workspace up, a hold line takes its place), and `resume with:` buttons appear for the owner.
- **CLI run.** Run a command as a session. Run
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Stdout shows
  `✓ project <project>`, `✓ worktree <name> · branch <branch>`, `✓ base … · session <id8>`,
  `  watch · <web>/sessions/<id>`, `✓ recording · run <id8> · workspace mounts the worktree`, and at
  the end `✓ session completed · recorded · checkpoint taken` and `  review · <web>/sessions/<id>`.
  Exit code `0`.
- **CLI harness, detached.** Run
  `mend claude "List the files and change nothing." --name verify-claude --project <project> --detach`.
  Stdout shows `✓ worktree verify-claude · branch <branch>`, then `✓ recording · running detached`
  and `  attach · mend attach <id8>`. Exit code `0`.
- **Second view.** Run `mend sessions --project <project> --json`. The JSON lists the
  `verify-claude` session with `"harness": "claude"` and a live `status`. Run
  `mend worktrees --project <project>`. `verify-web`, `verify-claude` and the `mend run` worktree
  are listed with their sessions.
- **CLI stop.** Run `mend stop <id8>`. Stdout shows `✓ stopped · claude · <id8> · <branch>` and
  `  review · <web>/sessions/<id>`. `mend sessions --project <project> --all --json` shows that
  session settled, and its `reviewUrl` still answers.
- **Proof.** Capture the session page once while running and once settled:
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` with the heading
  and status visible. Keep the `mend run`, `mend claude --detach`, `mend sessions --json` and
  `mend stop` transcripts.

## Gotchas

- The composer's prompt textarea has no label or `aria-label`. Its accessible name falls back to the
  placeholder `What should the session do?`, which Playwright finds, but the name changes whenever
  that copy does. That is a finding: it needs a label.
- The composer's harness, model and settings pills are buttons named only by their current value
  (`claude`, a model label, `settings` or a summary like `high · ask`). There is no stable
  accessible name to open the harness menu with. Its menu (`role="menu"`, no name) holds
  `menuitemradio` rows named `claude`, `codex`, `opencode` and `pi`. Prefer the worktree's
  `New session` menu, or the CLI, to pick a harness.
- The composer starts nothing until a worktree is picked: `Start` stays disabled. A project with no
  worktree needs `New worktree` first (the worktree picker's `New worktree` button opens the same
  dialog).
- `Base branch or ref` in the `New worktree` dialog has a branch list attached, so its role is
  `combobox`, not `textbox`.
- Each worktree's `New session` button carries the worktree's name only for screen readers:
  `New session in <worktree>`. Use that full name; plain `New session` is ambiguous on a page with
  several worktrees, and also matches the composer form's name.
- `Stop` on the session page needs `exact: true`: `Stop services` sits beside it while Services run.
- Section titles on the Now and session pages (`Needs you`, `Ready to review`, `Live`, `Terminal`,
  `Record`, `Checkpoints`, `Services`) are plain paragraphs, not headings or regions. Status words
  (`Running · recording`, `Completed · observed`) are plain text, not `role="status"`. Assert them
  with `getByText`.
- `mend codex` and `mend claude` ask for a worktree name when neither `--name` nor `--worktree` is
  given and both stdin and stdout are a TTY; otherwise the name is automatic. Pass `--name` (or
  `--worktree`) in a scripted drive. Without `--detach` they attach the terminal; run them in their
  own PTY.
- `mend run` refuses a prompt, harness flags, landing flags, `--detach` and `--foreground`. Its help
  page lists only `--project`; the launch code also reads `--name` for it, which `help.ts` does not
  document. Drive with the documented form and read the worktree name from the `✓ worktree` line.
- A first launch builds the harness image and can take minutes ("provisioning workspace — a first
  launch builds the harness image (can take minutes)…"). Wait for the status word, not a fixed
  sleep.
- Starting a session in another person's worktree states that the workspace is shared before it
  starts. A disposable instance with one account avoids that branch.
