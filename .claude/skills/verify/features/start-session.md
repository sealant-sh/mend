# Start a session

A session is one supervised conversation with a coding agent, or one command of the user's own, in a
git worktree of an adopted project. A user starts one from the Now page's composer, from a
worktree's `New session` menu, or with `mend codex`, `mend claude` or `mend run`; from the dashboard
with `w` or `n`; from the desktop launcher; from a project on the phone; from VS Code; or with
`@mend` in Slack. Mend records everything it does and opens the session's page, where its status
reads as an observation ("Running · recording", "Completed · observed").

## Sub-features

- `start-composer` starts a session from the Now page composer: project, worktree, harness, prompt.
- `start-new-worktree` creates a worktree from the `New worktree` dialog, from the project page or
  from inside the composer's worktree picker.
- `start-in-worktree` starts another session in an existing worktree from its `New session` menu.
- `start-cli-harness` launches `mend codex` or `mend claude` in a named worktree, attached or
  detached.
- `start-cli-run` runs any command as a session with `mend run` and returns when it settles.
- `start-tui` creates a worktree and starts a session from the dashboard (`w`), or starts another
  session in the selected worktree (`n`).
- `start-desktop` starts one from the desktop launcher or its inline composer, or opens a shell
  session (`Open a shell`).
- `start-mobile` starts a `claude` or `codex` conversation from a project on the phone.
- `start-vscode` starts one from `Mend: New Session…` or `Mend: New session in this worktree…`.
- `start-slack` starts one with `@mend <prompt>` in Slack.
- `session-page` shows the session's status, terminal or record, checkpoints, and the way to its
  review.
- `session-attach-resume` takes a live session's terminal (`a` in the dashboard), or resumes a
  settled one (`r`, the desktop's `resume`, the phone's `Resume`).
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
- CLI: `mend sessions`, `mend worktrees`, `mend attach`, `mend stop`.
- TUI: the dashboard (`mend ui`, or bare `mend`). `w` opens the `new worktree · <project>` box
  (name, base, harness); `n` on the projects pane, or in a project with no worktree, opens the same
  box. `n` on the worktrees or sessions pane opens `new session in <worktree> · pick a harness`. On
  a selected session, `a` attaches, `r` resumes a settled one on a picked harness, `Shift+K` twice
  stops it, and `o` opens its web page.
- Desktop: the `+` button on a project's sidebar row (named `New session in <project>`), or
  `New session` in the project row's right-click menu, opens the launcher dialog. With no tab open,
  the main pane shows the same composer inline under `New session · <project>`. The inbox face's `+`
  does the same. `Open a shell` in the composer starts a shell session in a new worktree. A session
  tab's header has `stop` and, once settled, `resume`; a session row's right-click menu has `Stop`.
- Mobile: the Projects tab lists, under each project, a worktree-name field and a `claude` and a
  `codex` row, each with `Start`. The Project screen (`/project/<id>`) holds the same under
  `Start a session`, but nothing in the app links to it. The Now tab lists sessions under
  `Needs you`, `Live` and `Recently settled`; a row opens `/session/<id>`.
- VS Code: `Mend: New Session…`, `Mend: New session in this worktree…`,
  `Mend: New worktree without an agent…` and `Mend: Stop session`.
- Slack: `@mend <prompt>` in a channel or thread the organization's Slack app is in starts a session
  for the person (see [Slack](./slack.md)).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in, and `<project>` is adopted (see
  [Adopt a project](./adopt-project.md)).
- For the harness steps, `mend connect claude` (or `codex`) has been run against this instance. The
  `mend run`, TUI shell and desktop shell steps need no provider. The mobile steps need one.
- No worktree named `verify-web`, `verify-run`, `verify-claude`, `verify-tui`, `verify-desktop` or
  `verify-mobile` exists in `<project>` (`mend worktrees --project <project>`).
- TUI steps: tmux, and Node 26 or newer for the dashboard.
- Desktop steps: the app runs from source with a debugging port
  (`pnpm --filter @mend/desktop exec electron-vite dev --remoteDebuggingPort 9222`), is connected to
  `<web>` and signed in through its connect screen (see [Sign-in](./sign-in.md)), and Playwright
  holds its window: `const browser = await chromium.connectOverCDP("http://127.0.0.1:9222")`, then
  `const page = browser.contexts()[0].pages()[0]`.
- Mobile steps: the Expo web build at `<mobile-web>`, paired and allowed, as in
  [Adopt a project](./adopt-project.md).

- **Create a worktree.** Open the project and choose `New worktree`. Run
  `await page.getByRole("main").getByRole("link", { name: new RegExp("^<project> ") }).click()` from
  `/projects` (scoped to `main`, and ending the name with a space, because the sidebar repeats each
  project as a link named exactly by its name), then
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
  `  watch · <web>/sessions/<id>`,
  `✓ recording · sh · workspace mounts the worktree · Ctrl+C stops watching, not the command` (the
  program's name after `recording ·`), the command's own output, and at the end
  `✓ exited · code 0 · recorded` and `  review · <web>/sessions/<id>`. Exit code `0`, the command's
  own.
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
- **TUI: open the dashboard.** Run `tmux new-session -d -s mend-ui -x 200 -y 50 'mend ui'`. The
  first line of `tmux capture-pane -p -t mend-ui` reads ` mend  <n> projects · <n> live` with the
  server URL at the right. The keyboard starts in the sessions pane; its footer reads
  ` ↑↓ move · ←→ panes · a attach · r resume · n new session · w new worktree · ⇧K stop · ⇧D remove · v review · e rename · o web · q quit`.
- **TUI: select the project.** Run `tmux send-keys -t mend-ui h h`. The projects pane is open and
  the footer reads ` ↑↓ move · → worktrees · n/w new worktree · ⇧R refresh · q quit`. Press `j` or
  `k` until the row marked `▌` reads `<project>`.
- **TUI: new worktree.** Run `tmux send-keys -t mend-ui w`. A box titled `new worktree · <project>`
  opens with the rows `name`, `base` and `harness`, and the footer ` enter continue · esc cancel`.
  Run `tmux send-keys -t mend-ui -l verify-tui`, then `tmux send-keys -t mend-ui Enter`. The base
  step lists the project's branches, one marked `default`, under the footer
  ` type to filter · ↑↓ move · enter choose base · esc back`. Once the list shows, press `Enter`
  (the highlighted branch). The harness step lists `codex`, `claude`, `opencode`, `pi` and `shell`,
  with the footer ` ↑↓ move · enter launch · esc back`.
- **TUI: launch a shell session.** Run `tmux send-keys -t mend-ui Down` four times, a moment apart,
  then `tmux send-keys -t mend-ui Enter` (sent as one `send-keys`, the five keys arrived together,
  the list stayed on `codex` and `Enter` launched codex). The box closes. The status line reads
  `provisioning shell workspace · <n>s elapsed`, then `started · shell <id8> · a attaches` (or
  `still starting · shell <id8> · a attaches once the row reads running`). The sessions pane shows
  `shell <id8>` with `starting`, then `running`, and the session pane reads
  `shell · no conversation record; a attaches if live`.
- **TUI: another session in the worktree.** With the new row selected, run
  `tmux send-keys -t mend-ui n`. A box titled `new session in verify-tui · pick a harness` lists the
  harnesses, with the footer ` ↑↓ move · enter start · esc cancel`. Run
  `tmux send-keys -t mend-ui Down` four times, a moment apart, then
  `tmux send-keys -t mend-ui Enter`. The status line reads
  `starting shell in the worktree · <n>s elapsed`, then `started · shell <id8> · a attaches`, and
  the pane title reads `sessions · 2`.
- **TUI: attach and detach.** Run `tmux send-keys -t mend-ui a`. The dashboard gives way to
  `attaching · shell · <id8> · detach: Ctrl+]` and the shell. Run `tmux send-keys -t mend-ui C-]`.
  The dashboard returns with `detached · <id8> keeps running`.
- **TUI: open the web page.** Run `tmux send-keys -t mend-ui o`. The status line reads
  `opened · <web>/sessions/<id8>…`.
- **TUI: stop.** Run `tmux send-keys -t mend-ui K`. The status line reads
  `press ⇧K again to stop · shell <id8>`. Within five seconds run `tmux send-keys -t mend-ui K`
  again. It reads `stopped · shell <id8> · the record and review remain`.
  `mend sessions --project <project> --all --json` shows that session `stopped`.
- **TUI: resume.** Select the settled `verify-claude` session from the CLI stop step (`h` to the
  worktrees pane, `j`/`k` to `verify-claude`, `l` back to the sessions pane). Run
  `tmux send-keys -t mend-ui r`. A box titled `resume claude <id8> · pick a harness` (or the
  session's label) lists `claude` first with `same harness · native resume, conversation intact`.
  Run `tmux send-keys -t mend-ui Enter`. The status line reads
  `resuming <name> · a fresh workspace restores the saved state · <n>s elapsed`, then
  `resumed · <name> · a attaches` (or `still resuming · …`). Stop it again with `K` twice, then quit
  with `q`.
- **Desktop: the launcher.** Run
  `await page.getByRole("button", { name: "New session in <project>" }).click()`. A dialog named
  `New session in <project>` opens
  (`const dialog = page.getByRole("dialog", { name: "New session in <project>" })`), titled
  `New session · <project>`, with focus in the worktree name field.
- **Desktop: open a shell session.** Run
  `await dialog.getByRole("textbox", { name: "worktree name — e.g. fix-auth (empty = auto)" }).fill("verify-desktop")`,
  then `await dialog.getByRole("button", { name: "Open a shell" }).click()`. The button reads
  `Opening…`, the dialog closes, and a tab opens whose header shows the status word (`starting`,
  then `running`) and the branch `mend/verify-desktop`. The sidebar lists a row whose name starts
  with `shell · `.
- **Desktop: start an agent.** Needs a provider. Open the launcher again and type `verify-desktop`
  into the worktree name field; an existing name joins that worktree. Click the harness pill (a
  button named by the current harness, such as `claude`), then
  `await page.getByRole("menuitemradio", { name: /^claude/ }).click()`. Fill
  `await dialog.getByRole("textbox", { name: "What should the session do?" }).fill("List the files and change nothing.")`
  and run `await dialog.getByRole("button", { name: "Start", exact: true }).click()`. The button
  reads `Starting…`, then a tab opens; its status word reads `starting`, then `running · recorded`.
- **Desktop: stop and resume.** In that tab's header run
  `await page.getByRole("button", { name: "stop", exact: true }).click()`. It reads `stopping…`,
  then the status word reads `stopped` and `resume` appears. Run
  `await page.getByRole("button", { name: "resume", exact: true }).click()`. It reads `resuming…`
  and the status word returns to `starting`, then `running · recorded`.
- **Desktop: stop from the sidebar.** Right-click the session's row. A row is named by its title,
  `<harness> · <label, or the branch when there is none>`, then its state word or age; read the
  label and branch from `mend sessions --project <project> --json` and run
  `await page.getByRole("button", { name: new RegExp("^claude · <label or branch>") }).click({ button: "right" })`.
  A menu lists `Open`, `Services`, `Copy branch` and `Stop`. Click `Stop`
  (`page.getByRole("menuitem", { name: "Stop", exact: true })`); the item now reads
  `Stop the coding agent?`. Click it again. The row's session settles.
- **Mobile: start a conversation.** Needs a provider. Run
  `await page.goto("<mobile-web>/projects")`. Under `<project>`, fill
  `page.getByRole("textbox", { name: "worktree name — e.g. fix-auth (empty = auto)" })` with
  `verify-mobile` (scope it to the project when several are listed), then tap the `Start` on the
  `claude` row, the first `Start` under that project. The app opens `/session/<id>?mode=protocol`;
  the header reads `claude` with `claude · <model> · starting · verify-mobile` under it.
- **Mobile: send the first message.** Run
  `await page.getByRole("textbox", { name: "Message the session…" }).fill("List the files and change nothing.")`
  and tap `Send` (`page.getByText("Send", { exact: true })`). The status word moves to `running`.
- **Mobile: Now.** Run `await page.goto("<mobile-web>/")` to return to the tabs, then tap `Now`
  (`page.getByRole("tab", { name: "Now" })`). The meta line reads
  `nothing waiting on you · <n> live` (or `<n> waiting · <n> live`), and the session is listed under
  `Live` by its label, or `session <id8>` before it has one.
- **Mobile: resume.** After `mend stop <id8>` on that session, open `/session/<id>`. The header has
  the button `Resume` (`page.getByRole("button", { name: "Resume" })`). Tap it. It reads
  `Resuming…`, and the status word leaves `stopped`.
- **VS Code.** `not drivable yet`: no VS Code harness. `Mend: New Session…` asks for the session
  kind, the harness (`Claude`, `Codex`, `opencode`, `pi`), the model, thinking, permissions and a
  prompt, under the title `New session · <project>`; `Mend: New session in this worktree…` asks the
  same under `New session · <project> › <worktree>`. The end state is a new session in the Mend tree
  and in `mend sessions`. `Mend: Stop session` asks `Stop <session>?` with
  `The worktree and reviewable change remain.` and the button `Stop session`.
- **Slack.** `not drivable yet`: it needs a Slack workspace with the organization's Slack app
  connected. `@mend <prompt>` gets a ⏳ reaction and one status message naming the project, why it
  was chosen, the harness, the state and the branch, with `Open in Mend`.
- **Proof.** Capture the session page once while running and once settled:
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` with the heading
  and status visible. Keep the `mend run`, `mend claude --detach`, `mend sessions --json` and
  `mend stop` transcripts, `tmux capture-pane -p` after each TUI key, the desktop window's ARIA
  snapshot with the tab header visible, and the phone's session screen.

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
- `mend run` refuses a prompt, harness flags, landing flags and `--foreground`. It takes
  `--project`, `--name <n>` (an existing name joins it), `--worktree <n>`, `--base <ref>`,
  `--detach` and `--json` (`mend help run`). `mend run --detach --json -- sleep 1800` returns once
  the command runs and prints its `sessionId` and `worktree`: a live session without holding a PTY.
  Without `--name` the worktree name is automatic; read it from the `✓ worktree` line.
- A first launch builds the harness image and can take minutes ("provisioning workspace — a first
  launch builds the harness image (can take minutes)…"). Wait for the status word, not a fixed
  sleep.
- Starting a session in another person's worktree states that the workspace is shared before it
  starts. A disposable instance with one account avoids that branch.
- TUI status lines clear five seconds after they appear; capture right after the key. `⇧K` arms a
  stop, and only a second `K` while that line still shows fires it. `x` also stops, though the
  footer does not name it.
- In the TUI's base step the filter field appears only once the branch list has loaded; an `Enter`
  before then does nothing. `Tab` also moves on to the harness step.
- On the projects pane, `a`, `r`, `⇧K`, `⇧D`, `e`, `o` and `v` answer
  `select a session first · → opens worktrees`, and `n` opens the new-worktree box rather than a
  session in an existing worktree.
- The TUI's `new session in <worktree>` box shows the same harness hints as a new worktree
  (`mend <harness> · new worktree, recorded session`,
  `a plain bash session · new worktree, recorded`) though the session joins the selected worktree
  (`deriveHarnesses(null)`, `apps/cli/src/dashboard-model.ts:436`, used at
  `apps/cli/src/dashboard.tsx:814`). That copy is a finding.
- The dashboard hides a settled session only when `hasTranscript === false` (`isDeadEnd`,
  `apps/cli/src/dashboard-model.ts:345`); `mend sessions --all` still lists it. Sessions whose
  transcript state is unknown and shell sessions remain listed.
- On the desktop, `New session in <project>` names the `+` button, the launcher dialog and the
  composer form inside it (the inline composer form too). Ask for the role.
- The desktop composer's fields have no labels: the worktree name and the prompt are named by their
  placeholders (`worktree name — e.g. fix-auth (empty = auto)`, `What should the session do?`), and
  the harness, model and settings pills by their current values
  (`apps/desktop/src/renderer/src/components/launcher.tsx:255`). Those are findings.
- The desktop composer has no worktree picker. Typing an existing worktree's name joins it, and the
  composer does not say so before `Start`.
- The desktop's `+` on a project row is transparent until hovered; Playwright still clicks it.
- The desktop header actions are lowercase (`stop`, `resume`, `delete`, `mark checkpoint`).
  Playwright matches a name string case-insensitively as a substring unless `exact: true`, so `stop`
  without it also matches `stop services`.
- The desktop's `delete` asks through a native confirm. Accept it with
  `page.once("dialog", (d) => d.accept())` before the click. Right-click menu items that destroy
  something need two clicks: the first renames the item to its question.
- The phone starts only `claude` and `codex`, as conversations; it has no shell or `mend run`. Its
  `Start`, `Send` and the composer's `Stop` are pressables with no role, and each harness row has
  its own `Start`, so position under the project is the only handle
  (`apps/mobile/src/components/start-session.tsx:142`). That is a finding.
- The phone's Project screen (`/project/<id>`) is reachable only by its URL: nothing in the app
  navigates there. That is a product gap.
- The phone's `Stop session` sits under `More actions` and asks through a native alert, which does
  nothing on the web build (`apps/mobile/src/components/session-pane.tsx:305`). Report it
  unreachable on the web build and stop with `mend stop`. The composer's `Stop` interrupts the turn;
  it does not end the session.
- The phone's session rows have no role; tap one by its title text. Their slide-left rename and
  delete are gestures this map does not drive.
