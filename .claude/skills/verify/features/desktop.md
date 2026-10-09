# Desktop app

The desktop app (`apps/desktop`, Electron) shows the sessions on a Mend server as terminals. A left
rail lists projects as a tree, or every agent session as an inbox; tabs across the top hold each
project's session and shell tabs; one terminal fills the rest. Every terminal is a session process
on the server, reached over `/api/tty`, so the app and a `mend attach` elsewhere show the same PTY.
An ended session replays its record. Review, the Land sheet and the Services sheet open inside the
app. The app signs in with `mend login`'s device flow and shares the CLI's credential file. There is
no published build: it runs from source.

## Sub-features

- `desktop-launch` builds and starts the app from source with an isolated profile and credential
  file, with a remote debugging port.
- `desktop-connect` signs in on the Connect screen (browser device flow, or a pasted token) and
  signs out.
- `desktop-rail` switches the rail between its tree and inbox faces, expands projects, opens rows,
  and carries each row's context menu.
- `desktop-inbox` lists agent sessions in static order with the Snoozed and Settled shelves, snooze,
  the project scope menu, and the scoped Services, PRs and Files views.
- `desktop-launcher` starts a session from the launcher dialog or the inline composer: worktree
  name, prompt, harness, model, settings, or `Open a shell`.
- `desktop-tabs` holds session tabs and supporting-shell tabs per project; opens, detaches and stops
  shells.
- `desktop-terminal` attaches the live PTY, with the header strip's actions: Services, review the
  change, land, mark checkpoint, stop, delete.
- `desktop-conversation` shows a protocol-mode session as a conversation: send, interrupt,
  approvals, questions.
- `desktop-replay` replays an ended session's record with a checkpoint scrubber and a terminal or
  conversation toggle; offers resume and the handoff between modes.
- `desktop-review` opens the pinned review in the app (`#/review/<change>/<slice>`): files, toolbar,
  comments, follow-up delivery, `New snapshot`.
- `desktop-land` opens the Land sheet from the session header, the landing strip, or Review.
- `desktop-services` opens the Services sheet: Services, recipes, one-off commands, logs.
- `desktop-shared-control` shows the owner's `Shared control` switch, the lines others read, and the
  workspace facts with `Replace this workspace now`.
- `desktop-palette` jumps to any agent session with `Ctrl+Shift+P`.
- `desktop-settings` sets the terminal font, theme and default harness, shows the connection, and
  connects provider accounts.

## How to get to it (user POV)

- Desktop: there is no installer. From a checkout, `pnpm install`, then
  `pnpm --filter @mend/desktop dev` (electron-vite dev), `pnpm --filter @mend/desktop start`
  (preview of a build), or `pnpm --filter @mend/desktop package` (electron-builder; Linux AppImage
  and tar.gz, macOS dmg and zip, into `apps/desktop/release/`).
- Desktop routes are hash routes in one window: `#/` (the cockpit), `#/connect`, `#/settings`,
  `#/review/<changeId>/<sliceId>`.
- Desktop titlebar: the `Settings` link (gear), and a link to Connect that appears only when the
  event stream is not live (`mend · not connected`, `mend · reconnecting`, `mend · signed out`).
- Desktop keys (one capture-phase listener, so they work while the terminal has focus):
  `Ctrl+Shift+J`/`K` next/previous agent session, `Ctrl+Shift+H`/`L` previous/next project,
  `Ctrl+Shift+T` new shell in the focused session (the launcher when only a project is focused),
  `Ctrl+Shift+W` close the focused tab, `Ctrl+Tab`/`Ctrl+Shift+Tab` tabs, `Ctrl+1`…`9` jump to a
  rail row, `Ctrl+Shift+P` palette, `Ctrl+Shift+B` tree ⇄ inbox, `Ctrl+Shift+S` Services sheet,
  `Ctrl+Shift+=`/`-`/`0` terminal font, `Ctrl+,` settings, `Alt+Space` summon the window (global).
- CLI: nothing launches the app. `mend login` and `mend logout` write the credential file the app
  reads and watches (`$XDG_CONFIG_HOME/mend/cli.json`), so they sign the running app in or out.
- Web: Settings → Devices lists the app as `<hostname> · desktop` once it signed in with the device
  flow (see [Sign in](./sign-in.md) and [Pairing devices](./pairing-devices.md)).
- Docs: `apps/docs/src/content/docs/clients/desktop.md`.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and `<project>` is adopted (see [Adopt a project](./adopt-project.md)).
- The repository's dependencies are installed (`pnpm install` at the root). The host has a display;
  on a headless host the app needs a virtual one (for example Xvfb).
- A scratch directory `<scratch>` holds this run's state. The CLI under test signed in with it:
  `XDG_CONFIG_HOME=<scratch>/config mend login --url <web>`. The app then reads that credential
  file, never the owner's `~/.config/mend/cli.json`.
- A settled session in `<project>` holds a change:
  `XDG_CONFIG_HOME=<scratch>/config mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`.
  Note its id `<id>` and the worktree name `<run-worktree>` from the `✓ worktree` line.
- No worktree named `verify-desk` exists in `<project>`.
- Start the app with its own profile and a debugging port, and record its PID:
  `XDG_CONFIG_HOME=<scratch>/config MEND_USER_DATA=<scratch>/desktop MEND_URL=<web> pnpm --filter @mend/desktop dev --remoteDebuggingPort 9222`.
  It is ready when `curl -s http://127.0.0.1:9222/json/version` answers and `/json/list` lists a
  page target.

- **Attach.** Run `const browser = await chromium.connectOverCDP("http://127.0.0.1:9222")` and
  `const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"))`. The
  navigation `Projects and sessions` is visible
  (`page.getByRole("navigation", { name: "Projects and sessions" })`), and the titlebar reads `Mend`
  and `· cockpit · <n> sessions live`. Without a credential the window shows `#/connect` instead,
  with the heading `Connect to your Mend server` and `Not signed in to a Mend server yet.`.
- **Sign in from the app (fresh credential only).** With an empty `<scratch>/config`, run
  `await page.getByRole("textbox", { name: "Server URL" }).fill("<web>")` and
  `await page.getByRole("button", { name: "Sign in with the browser" }).click()`. The form shows
  `Approve in the browser if it shows this code`, the code, a button named by the authorize URL, and
  `waiting for approval · open until <time> · nothing is granted until someone approves`. Approve
  that URL in the web browser as in [Sign in](./sign-in.md). The window moves to the cockpit and
  `<scratch>/config/mend/cli.json` holds `url`, `token` and `deviceId`.
- **Rail faces.** Run
  `const faces = page.getByRole("group", { name: "Sidebar face" })`. Its button `tree` has
  `aria-pressed="true"`. Run `await page.keyboard.press("Control+Shift+B")`. The button `inbox` is
  pressed and the rail shows the scope pill `All projects`, the active rows and the `settled` shelf.
  Press `Control+Shift+B` again to return to the tree.
- **Expand the project.** Run
  `const projectRow = page.getByRole("navigation", { name: "Projects and sessions" }).getByRole("button", { name: new RegExp("^<project>") })`.
  The focused project's tree starts open; when its `aria-expanded` is `false`, click it. With
  `aria-expanded="true"` the tree shows `sessions` with `<live>/<total>` and a row whose name
  starts `run · ` for the `mend run` session.
- **Open the launcher.** Run
  `await page.getByRole("button", { name: "New session in <project>" }).click()`. A dialog named
  `New session in <project>` opens, headed `New session · <project>`, with focus in the worktree
  name field.
- **Open a shell session.** Run
  `const launcher = page.getByRole("dialog", { name: "New session in <project>" })`,
  `await launcher.getByRole("textbox", { name: "worktree name — e.g. fix-auth (empty = auto)" }).fill("verify-desk")`,
  then `await launcher.getByRole("button", { name: "Open a shell" }).click()`. The button reads
  `Opening…`, the dialog closes, and the tab bar gains a tab whose name contains
  `shell · mend/verify-desk`. The header strip shows the status word (`starting`, then
  `running · recorded`) and `mend/verify-desk`. Until the PTY binds, the pane reads
  `provisioning workspace — the terminal attaches the moment the PTY is live (a first launch can take minutes)…`.
- **Type in the terminal.** Run
  `await page.getByRole("textbox", { name: "Terminal input" }).focus()` and
  `await page.keyboard.type("printf 'desktop\\n' > DESKTOP.md\n")`. The shell runs the line; the
  output draws on the terminal canvas (take a screenshot). Run `mend worktrees --project <project>`:
  `verify-desk` is listed with its `shell` session.
- **Supporting shell tab.** Press `Control+Shift+T`. A second tab opens for a supporting shell; its
  header reads `<label> · session worktree · mend/verify-desk` with the buttons `rename` and
  `detach tab`. Right-click that tab's button (`click({ button: "right" })`); a menu opens with
  `Detach tab` and `Stop shell`. Click `Stop shell`: the item now reads `Stop the process group?`.
  Click it again. The tab closes and the tree no longer lists that shell under the session.
- **Mark a checkpoint.** On the `verify-desk` session tab, run
  `await page.getByRole("button", { name: "mark checkpoint" }).click()`. It reads `marking…`, then
  `mark checkpoint` again.
- **Services sheet.** Run `await page.getByRole("button", { name: /^Services \d+$/ }).click()` (or
  press `Control+Shift+S`). The complementary region `Session Services` opens, headed `Services`
  with the session's branch; with nothing running it reads `No Services in this session.`, and under
  `Recipes` either the recipes from `mend.toml` with `Run`, or `No recipes declared in mend.toml.`.
  Close it with
  `page.getByRole("complementary", { name: "Session Services" }).getByRole("button", { name: "Close" })`.
- **Palette.** Press `Control+Shift+P`. A dialog named `Sessions` opens with focus in its search
  field. Type `<run-worktree>` and press `Enter`. The dialog closes and the `run · …` session's tab
  is focused.
- **Replay a settled session.** On the `run · …` tab the pane does not attach. It replays the record
  with a scrubber: the group `Replay checkpoints` holds one button per checkpoint, named
  `Replay from checkpoint <i>, seq <seq>`, the label reads `▶ replay · from seq <seq> · …`, and the
  fact line states how the process ended (for example `exited · observed`). The group `Record view`
  switches between `terminal` and `conversation`. When the record holds no terminal output the
  label reads `no terminal output recorded to replay`. Click a checkpoint button: the label names
  that checkpoint and the replay restarts from its sequence.
- **Review in the app.** Run
  `await page.getByRole("button", { name: "review the change" }).click()`. It reads
  `opening Review…`, then the URL hash becomes `#/review/<change>/<slice>`. The heading is the
  session's branch, beside `<sha A> → <sha B> · <digest>`. The file list holds a button whose name
  starts `VERIFY.md`, and the toolbar holds `Unified`, `Split`, `Whitespace included`, the `Context`
  select, `← file`, `file →`, `← hunk`, `hunk →`, `← comment`, `comment → 0` and the textbox
  `Search Review`.
- **Comment on the change.** Run
  `await page.getByRole("button", { name: "Comment on change" }).click()`, then
  `await page.getByRole("textbox", { name: "Describe what you observed or want changed." }).fill("Say why VERIFY.md exists.")`
  and `await page.getByRole("button", { name: "Add comment" }).click()`. A comment card appears
  with `Mark addressed` and `Dismiss`, and the toolbar button reads `comment → 1`. Run
  `await page.getByRole("button", { name: "← Workbench" }).click()` to return.
- **Land sheet.** On the `run · …` tab, run `await page.getByRole("button", { name: "land", exact: true }).click()`.
  The complementary region `Land the change` opens. Its region `What Mend observed` reads
  `not landed · nothing pushed from Mend yet`, and its region `Land this change` holds the land
  button (`Push and open pull request`, or `Push to origin` with the reason when origin is not on
  GitHub). Do not press it unless the origin is disposable (see
  [Land a change](./land-change.md)). Close with the sheet's `Close`.
- **Settings.** Run `await page.getByRole("link", { name: "Settings" }).click()` (or press
  `Control+Comma`). The heading `Settings` shows, with the headings `Terminal`, `Appearance`,
  `Workbench`, `Connection`, `Connected accounts` and `Keyboard`. Run
  `await page.getByRole("button", { name: "Bigger" }).click()`: the size reads `13px` (from the
  default `12px`) and a `reset` button appears. Run
  `await page.getByRole("button", { name: "dark", exact: true }).click()`: it is pressed and the
  page turns dark. Under `Connection` the row reads `Signed in` and
  `<web> · credential shared with the mend CLI at <scratch>/config/mend/cli.json`. Restore the size
  with `reset` and the theme with `system`.
- **Stop the shell session.** Back in the cockpit, right-click the tree row whose name starts
  `shell · mend/verify-desk`. The menu holds `Open`, `Services`, `Copy branch` and `Stop`. Click
  `Stop`; it reads `Stop the shell?`; click again. The row's status word turns to its settled word,
  and `mend sessions --project <project> --all --json` shows the session settled.
- **Proof.** Capture `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })`
  of the cockpit with the live shell tab, of the replay with its scrubber, of the review page, and
  of the Land sheet. Keep the `mend run`, `mend worktrees` and `mend sessions --json` transcripts
  and the app's stdout.

## Gotchas

- The app reads and writes the CLI's credential file and watches it. Without `XDG_CONFIG_HOME`
  pointed at scratch it uses the owner's `~/.config/mend/cli.json`, and `sign out` there revokes the
  owner's device and empties the CLI's token too. Always launch with a scratch `XDG_CONFIG_HOME`.
- The app holds a single-instance lock on its profile. A second launch without `MEND_USER_DATA`
  quits at once and raises the owner's window instead. `Alt+Space` is a global shortcut; the run's
  instance takes it only when no other app holds it.
- `Sign in with the browser` calls the OS to open the approve page in the system browser. In a
  verify run, approve the URL shown on the Connect form in the Playwright browser and ignore the
  opened tab.
- Stop the app by the PID recorded at launch. Never `pkill -f electron` or a bare `mend` pattern.
- The terminal draws on a canvas marked `aria-hidden`; its text is not in the accessibility tree.
  Prove terminal output with a screenshot, or with the session's record and the files it wrote.
  The `Terminal input` textarea has `pointer-events: none`: use `.focus()`, not `.click()`.
- The tab bar's new-shell button has no accessible name: its only text is `+` (its `title`,
  `New shell in focused session (Ctrl+Shift+T)`, is not its name). Use `Control+Shift+T`. Finding:
  `components/tab-bar.tsx:91`.
- Tab buttons have no label: their name is the tab number run together with the title
  (`1shell · mend/verify-desk`). Match with a regular expression on the title. Finding:
  `components/tab-bar.tsx:61`.
- Tree and inbox rows have no label either. A session row's name is the title (`<harness> · <label
  or branch>`) followed by the status word or a relative time; a project row's name is the project
  name, its default branch and, collapsed, its row count. Auto-naming can replace the branch with a
  label after the first prompt. Finding: `components/sidebar.tsx:135`, `:456`, `components/inbox-rail.tsx:564`.
- The launcher's worktree name field, prompt and base field have no label: their names come from
  placeholders (`worktree name — e.g. fix-auth (empty = auto)`, `What should the session do?`, and
  the project's default branch). The harness, model and settings pills, and the inbox scope pill,
  are named only by their current value (`claude`, a model label, `settings`, `All projects`).
  Findings: `components/launcher.tsx:255`, `:265`, `:469`, `:288`, `:296`, `:304`,
  `components/inbox-rail.tsx:271`.
- The launcher dialog and the form inside it share the name `New session in <project>`. Scope by
  role (`dialog`), not by name alone.
- The palette's search field is named only by its placeholder
  `Jump to a session — project, harness, branch…`. Finding: `components/command-palette.tsx:82`.
- The palette and the inbox list agent sessions only. A `shell` session (the launcher's
  `Open a shell`) appears in the tree and never in the inbox or the palette.
- The tree's `delete` button on a settled row is named `delete`; its `title`
  (`Delete session — the worktree remains`) is not its name. It and the header's `delete`, the
  inbox's `Delete session`, closing a live shell tab with `×`, and a live handoff all ask through
  `window.confirm`, a native dialog in Electron. Prefer the context menus, whose destructive items
  confirm in place (`Stop shell` → `Stop the process group?`).
- The shell header's `rename` calls `window.prompt` (`components/terminal-pane.tsx:487`). Electron
  does not implement `window.prompt`; check whether any dialog appears before relying on it, and
  report it as a finding if none does.
- In the review, the line numbers come from `@pierre/diffs` inside a shadow root and have no
  accessible name, as on the web; clicking one opens the line composer. The comment composer and
  the follow-up instruction are named only by placeholders (`Describe what you observed or want
  changed.`, `Select comments, then assemble an editable instruction.`). Findings:
  `components/review-diff.tsx:183`, `routes/review.$changeId.$sliceId.tsx:1090`, `:996`.
- The review toolbar's `title` texts (`Next file (])`, `Next hunk (J)`) are descriptions; the
  buttons' names are their text (`file →`, `hunk →`). The `Context` select's name comes from its
  wrapping label and may include the selected value; match `/^Context/`.
- The Services sheet's one-off fields are named only by placeholders
  (`command · leave empty to adopt a listening port`, `port`, `name`), and its scheme select has no
  name at all. Finding: `components/services-sheet.tsx:483`, `:491`, `:494`, `:495`.
- Settings: the font family field is named only by its placeholder `"JetBrains Mono"`; the three
  provider rows each have a `Connect` button with the same name and no region to scope by; the
  token field is a password input named only by its placeholder. Findings: `routes/settings.tsx:127`,
  `:404`, `:439`.
- The Services sub-view of a scoped inbox says a session declares a Service in its `mend.services`
  file; Services are declared in `mend.toml`, as the Services sheet itself says. Copy finding:
  `components/project-panes.tsx:73`.
- The docs page lists the launcher's harnesses as `claude`, `codex` or `opencode`; the app also
  offers `pi` (`lib/app-settings.ts:4`). Docs drift.
- The app cannot adopt a project or edit project settings yet (BRIEF.md milestone M4). An empty tree
  says `no projects — adopt one with mend adopt`.
- `land`, `landing` and the strip under the header appear only once the session has a change and
  its landing record answers. `Check GitHub`, `Check origin` and `Refresh pull request` follow the
  same rules as on the web (see [Land a change](./land-change.md)).
- A conversation (protocol-mode) session shows the composer `Message the session…` with `Send` and,
  while a turn is open, `Interrupt`; approvals read `Allow once`, `Allow for session`, `Decline`.
  Starting one needs `Runs as` → `Conversation` in the launcher's settings menu and a connected
  provider. Its composer and answer fields are named only by placeholders. Findings:
  `components/conversation.tsx:431`, `:258`.
- `sign out · revokes this device when it is one, removes the token` on the Connect screen and
  `Sign out` in Settings revoke the device on the server. Sign out only in a run whose credential
  is scratch.
