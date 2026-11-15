# Driving VS Code

Read this before `pnpm verify drive vscode`, or before writing a VS Code recipe: the world
`drive-vscode.mjs up` makes, and every helper a recipe has. In this file, Launch is
`pnpm verify stack up` and Cleanup is `pnpm verify stack down`. `$E` is the run's evidence
directory, `$P` its private directory, `$wt` its outer worktree and `$web` its tunnel;
`.verify/stack/current.json` names each for the run that is up.

**VS Code.** `drive-vscode.mjs` drives a real VS Code the way a person clicks through it: the Mend
extension built from a checkout (`--extensionDevelopmentPath`), Microsoft's Remote-SSH installed, on
an Xvfb display of its own, with a remote debugging port that Playwright attaches to over CDP and a
recipe that clicks the workbench DOM. It runs against a world of its own, not the stack: a packaged
Mend server in Docker-in-Docker (`scripts/vscode-remote-world.mjs`, shared with the Remote-SSH
acceptance `scripts/vscode-remote-acceptance.mjs`), reached at the daemon's own address, with the
first account, one adopted project and a local clone of it open in the first window. The world
outlives one call, like the desktop's app:

```sh
# boot: a preloaded ghcr.io/sealant-sh/mend tag (`--version`), any image on this machine's Docker
# (`--image <ref>`), or one built now from the checkout's Dockerfile (`--build`, 20 to 40 minutes)
VSCODE_BIN=$(dirname "$(readlink -f "$(which code)")")/../lib/vscode/code \
  node $skill/scripts/drive-vscode.mjs up --version 0.36.0-next.1033 [--extension <checkout>] \
    [--signed-out | --cli-only] [--no-ssh-setup] [--no-remote-ssh] [--no-video] [--repo <url>] \
    [--run <name>]
export MEND_VERIFY_VSCODE_RUN=<the run `up` printed>
node $skill/scripts/drive-vscode.mjs run <recipe.mjs> --out "$E_vscode/<feature>" [--timeout <ms>]
node $skill/scripts/drive-vscode.mjs logs            # the editor's logs and the server's, redacted
node $skill/scripts/drive-vscode.mjs down            # the editor, ffmpeg, Xvfb, the daemon, the scratch
```

`up` takes about seven minutes from preloaded images (the extension build, the daemon, the images
copied in, `mend server setup`, one fresh-worktree session run and stopped so the workspace image
exists, Remote-SSH installed, the clone, then VS Code) and prints
`export MEND_VERIFY_VSCODE_RUN=<run>`; `run`, `logs` and `down` take `--run`, that variable, or the
only run that is up. Every name is run-scoped (`st-verify-vscode-<run>`: the daemon, the Docker
context, the project), so two runs on one machine do not collide and nothing of `local-outer.sh`'s
is touched. The ledger `~/.cache/mend-verify/vscode/st-verify-vscode-<run>/state.json` holds the
pids, the display, the CDP port, the server URL and every path, written as each resource appears, so
`down` converges after a crash too (twice in a row is fine). The private directory beside it holds
the account's token and its web password (`token.secret`, `password.secret`, both in the run's
registry); the evidence goes to
`${XDG_STATE_HOME:-~/.local/state}/mend-verify/st-verify-vscode-<run>/`: `display.mp4` (ffmpeg's
x11grab of the display, 5 frames a second, when ffmpeg is on PATH; `nix shell nixpkgs#ffmpeg` has
it), each recipe's `--out`, and `logs/`. `down` scans that evidence against the registry before the
private directory goes.

The editor starts **signed in** (the CLI connection, `cli.json` in the scratch HOME, written as
`mend login` writes it, and `mend.serverUrl` naming its server, as after story h's **Use it**) with
**workspace SSH set up** (`mend ssh setup` in that HOME, and `remote.SSH.remotePlatform` seeded for
the alias, as it is after story h's first run). `--signed-out` (no CLI connection, no setting),
`--cli-only` (the CLI signed in, the editor not connected: the view offers **Use it**) and
`--no-ssh-setup` start the first-run stories instead; `--no-remote-ssh` leaves Remote-SSH
uninstalled, so the first open installs it from the gallery (`state.remoteSsh` is `false`). The
editor's `workbench.externalBrowser` is a recorder in the scratch: a link VS Code opens is appended
to `state.browserLog` and never reaches a browser on this machine's desktop.

A recipe is a module whose default export is `async (helpers) => {}`. The helpers act like a person;
each is a gesture on the real workbench DOM:

- `palette(title)` (F1, the command's title typed, its row clicked), `paletteRows(query)` (what the
  palette lists for the text before she picks, each row's label and whether it reads disabled, then
  Escape: a command whose enablement is false is not listed), `quickInput.type(text)`,
  `.pick(label, { exact })` (a row holding the text; `exact: true`, the row whose label is it),
  `.accept()`, `.cancel()`, `.title()` (as VS Code draws it, a step counter `(2/5)` appended),
  `.step()` (`{ title, step, total }`, the counter split off, null without one), `.value()`,
  `.placeholder()`, `.rows()` (each row's `label`, `icons` by codicon name, `description`, `detail`,
  `buttons` by tooltip, `focused`), `.buttons()` (every button by tooltip and where: the title bar,
  the input box, a row), `.button(tooltip)` (one clicked: the title bar's or the input box's, else a
  row's with the pointer on its row), `.back()` (the title bar's Back), `.busy()`, `.items()`,
  `.isOpen()`, `.validation()` (`{ message, severity }` while the input shows a validation, null
  while the line under it is only the prompt), `.watch()` (every time the widget is shown from now,
  until `stop()`);
- `welcome()` (the view's welcome over an empty tree: its `lines`, `buttons` and `links`; null while
  the tree shows), `welcomeAction(label)` with `.click()` (a welcome button or link);
  `accounts({ signOut, shot })` (the Accounts menu's entries, then Escape; with `signOut`, the entry
  holding it is hovered and its **Sign Out** clicked, and VS Code then asks in a dialog; with
  `shot`, the open menu is shot first); `browserOpened()` (every URL the editor handed its external
  browser, from `up`'s recorder); `browser()` (Playwright's own chromium, apart from the editor:
  `.goto(url)`, `.signIn()` on the web's sign-in page as the run's account, `.click(name)` on a
  button, `.waitForText()`, `.text()`, `.shot(slug)` numbered among the editor's, `.close()`);
- `view(name)` (the Activity Bar entry), `viewActions()` (the view's title bar buttons, each
  `{ title, disabled }`), `viewAction(title | pattern)` with `.disabled()`, `.title()`, `.tooltip()`
  (the pointer rests on it until the hover shows; a disabled button too) and `.click()`,
  `viewOverflowItems()` (the view's `⋯` menu opened, each item `{ label, disabled }`, then Escape:
  the first view's header's `More Actions...` when the container shows headers, as Source Control
  does with Changes and Graph, else the title bar's; an extension's `scm/title` item outside the
  `navigation` group is listed in Changes' menu), `viewOverflowItem(label | pattern)` (an enabled
  item of that menu clicked, by its whole label or a RegExp it matches, the pointer resting on it
  first; returns the label clicked, and fails with every label the menu showed when none matches),
  `treeItem(label)` with `.click()`, `.dblclick()`, `.hover()`,
  `.inline(title | pattern, { clicks })` (the row's hover action, by its title or a RegExp its title
  matches; `clicks: 2` clicks it again at once; returns the title found), `.contextMenu(item)` (the
  whole label; the pointer rests on it before the click), `.menu()` (every context menu item, then
  Escape), `.actions()` (the inline action titles), `.tooltip()`, `.selected()`, `.text()`,
  `.description()` (a session row's status);
- `notification(text)` with `.click(button)`, `.text()`, `.dismiss()`; `notifications()`;
  `dialog(text)` with `.click(button)`; `dialogs()`; `statusBar(text)`; `statusBarItems()` (every
  item's text, left to right); `viewRows()` (the sidebar tree's rows with their depth, label,
  description and open state, and the view's message); `badge(name)` (the number on an Activity Bar
  entry, `""` without one);
- `terminal()` with `.type(line)`, `.read()` (the xterm rows from the DOM), `.waitForText()`,
  `.tabs()` (`{ names, active, focused }`: the panel's terminal tabs, the active one, whether the
  keyboard is in a terminal);
- `watch()`: from now until `stop()`, every toast, modal dialog, quick input title and status bar
  text that appears in the current window, each once, beyond what already showed (`stop()` returns
  null when the window navigated meanwhile); `userSettings(patch)` (the run's `settings.json`
  changed as a person edits it, live; a key set to undefined removed; `via: "setup"`);
  `openUrl(url)` (a `vscode://` link followed as the OS URL handler follows one: `code --open-url`
  with the run's user data; VS Code first asks `Allow '<extension>' extension to open this URI?` in
  a dialog of its own, which the recipe answers with `dialog("open this URI").click("Open")`);
  `openFolder(folder)` (a folder opened from a terminal: `code --new-window --skip-welcome <folder>`
  with the run's user data, as `up` started the editor; the window has the extension under test, and
  `waitForWindow(known)` finds it);
- `windows()` (every workbench window), `newWindows(known)` (what one gesture opened, once it has
  settled), `waitForWindow(known)`, `useWindow(page)`, `homeWindow()` (the local window, not a
  Remote-SSH one), `closeWindow(page)` (`Close Window` from that window's palette); a Remote-SSH
  open either reuses a window, which reloads its page, or opens a new one, so re-read `windows()`
  after it;
- `waitForText(text)`, `waitUntil(what, read, ms)`, `shot(slug)` (numbered screenshots into `--out`,
  `.png.checked` beside each; withheld when the window's text shows a credential),
  `step(name, fn, { via })` (one line per step into `steps.jsonl`: what was done, what was observed,
  the step's screenshot, its timing), `note(text)`, `api(route, init)` (the run's Mend client, for
  setting up state and for reading what Mend observed), `serverLogs()` (the server container's log,
  raw, context only: its `/v1/workspaces/<id>/ssh-target` lines also come from a window's SSH
  teardown, seconds after a close), `opens()` (Remote-SSH window opens so far, below),
  `remoteSshLogs()` (how many Remote-SSH output logs exist, context only), `state`.

A recipe counts opens on the client: each Remote-SSH window open or reload writes one line
`SSH Resolver called for "ssh-remote+…", attempt 1` into a `*-Remote - SSH.log` under
`<userData>/logs` (a reconnect writes `attempt 2` and up). `opens()` counts those lines once the
count has held still for 5 s. A recipe shows `opens()` +1 for the first window it opens on purpose
before any claim rests on it.

Clicking the real DOM is the rule. A step that calls the server, or any other setup path, says so
with `via: "api"` or `via: "setup"`, and only ever for setup or for reading what Mend observed,
never for the action under test. The recipes: `recipes/vscode-open.mjs` (stories c and e against
either build of the extension: today's fails at the double-click, the redesign passes),
`recipes/vscode-open-first.mjs` (the first open without Remote-SSH, from `up --no-remote-ssh`) and
`recipes/vscode-open-as-built.mjs` (#1080's extension as built), `recipes/vscode-view.mjs` (the Mend
view, badge, status bar and toasts: stories f, a4 and b on a server with G4),
`recipes/vscode-new-session.mjs` (story a with flow 3: New session's one quick input, Change…, an
unpushed base, a folder no project matched, a launch that fails and Retry, offline),
`recipes/vscode-first-run.mjs` (story h with flow 4: from
`up --signed-out --no-ssh-setup --no-remote-ssh`, Connect, the approve page denied then authorized
in `browser()`, Set up, Adopt and Sign Out from the Accounts menu; from
`up --cli-only --no-ssh-setup --no-remote-ssh`, Use it, Set up skipped, Connect cancelled while its
request is out, Open's one deferred question cancelled and then answered),
`recipes/vscode-answer-launcher.mjs` (Answer on her own terminal agent in a workspace Ana launched,
attached over `/api/tty`; it needs a server with G4 newer than `0.36.0-next.1033`, an image built
from main with `up --build`); the map's [vscode.md](features/vscode.md) has the flows by story.
`recipes/g4-terminal-agent-waits.mjs` drives no editor: it replays claude's hooks through
`scripts/fixtures/claude-standin.mjs` in a shell beside a real (signed-out) claude agent and reads
the session's `waiting` from the API and `/api/events`
([terminal-agent-waits.md](features/terminal-agent-waits.md)).

What cannot be driven, and why: VS Code draws its modals and context menus as GTK windows outside
the page unless `window.dialogStyle` and `window.titleBarStyle` are `custom` (the driver writes both
into the run's settings, as a person may set them); the terminal's text is readable only from the
DOM renderer (`terminal.integrated.gpuAcceleration: off`, written there too); an OS keychain prompt
or a file chooser would be native too, and none of the mapped flows opens one. A Remote-SSH connect
installs VS Code's server inside the workspace the first time; in the proof runs the first connect
took 3 to 8 s and later ones 3 to 4 s, so wait for it with a budget of minutes, not an expectation
of them. A tree row's accessible name is its tooltip, so `treeItem` matches the row's visible text.
The video is unredacted pixels: a recipe that puts a credential on screen runs with `--no-video`.
