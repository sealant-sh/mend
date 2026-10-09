# VS Code extension

The Mend extension for VS Code (`apps/vscode`) lists a person's projects and sessions in a
`Projects and sessions` view and opens a session inside its workspace over SSH: the editor's files
are the session's worktree, and its integrated terminal runs in the workspace, where Mend observes a
`claude` or `codex` started there. From the view a person starts a session (a workbench shell, a
Claude or Codex agent, or an agent with options), starts another session in the same worktree,
makes a worktree without an agent, takes over an agent Mend is running elsewhere so the
conversation continues in the editor's terminal, stops a session, and opens it in Mend's web app.
The extension is not published; it is built and installed from source.

## Sub-features

- `vscode-install` builds the extension and packages `mend-0.1.0.vsix` from source.
- `vscode-connect` reads the CLI's connection, or `Mend: Connect to server` overrides it.
- `vscode-view` shows `Needs you` and the projects with their sessions, scoped to the open folder's
  project unless toggled; the status bar names the project and what waits.
- `vscode-adopt` adopts a project from a clone URL and a name.
- `vscode-new-session` starts a Workbench shell, a Claude or Codex agent, or an agent with options.
- `vscode-new-in-worktree` starts another session in a session's worktree.
- `vscode-manual-worktree` creates a worktree without an agent and opens it.
- `vscode-open` opens a session's workspace over Remote - SSH; a settled one offers a workbench
  shell resume.
- `vscode-ssh-setup` registers this machine's key and writes the `Host` block (see
  [Workspace SSH](./workspace-ssh.md)).
- `vscode-takeover` ends the agent Mend runs elsewhere and resumes the same conversation in the
  editor's terminal.
- `vscode-stop` stops a live session; the worktree and change remain.
- `vscode-uri` opens a session from `vscode://sealant-sh.mend/open?session=<id>`.

## How to get to it (user POV)

- VS Code: the Mend icon in the Activity Bar opens the view `Projects and sessions`. Its title bar
  holds `Mend: New Session…`, `Mend: Refresh`, `Mend: Adopt a project…` and, when the open folder
  belongs to a project, `Mend: Toggle current project scope`. With nothing adopted it shows
  `Nothing adopted yet.` and the link `Adopt a project…`.
- VS Code: on a project row, inline `Mend: New Session…`; its context menu adds
  `Mend: New worktree without an agent…`.
- VS Code: on a session row, inline `Mend: Open in VS Code` and `Mend: Open in Mend`; its context
  menu adds `Mend: New session in this worktree…` and `Mend: Copy worktree path`, and on a live
  session `Mend: Take over session in the editor` and `Mend: Stop session`. Clicking a session row
  runs `Mend: Open in VS Code`.
- VS Code: the Command Palette lists every command, titles verbatim: `Mend: Refresh`,
  `Mend: Toggle current project scope`, `Mend: Connect to server`, `Mend: Adopt a project…`,
  `Mend: Open in VS Code`, `Mend: Take over session in the editor`,
  `Mend: New session in this worktree…`, `Mend: Open in Mend`, `Mend: Copy worktree path`,
  `Mend: Set up workspace SSH`, `Mend: Stop session`, `Mend: New Session…`,
  `Mend: New worktree without an agent…`, `Mend: Show project sessions`.
- VS Code: the status bar item `$(pulse) Mend: <project> · <n> sessions[ · <n> waiting]`, or
  `Mend: <project> › <session>` inside a session's workspace, runs `Mend: Show project sessions`.
- VS Code settings: `mend.serverUrl` and `mend.workspaceSshHost`.
- URI: `vscode://sealant-sh.mend/open?session=<session-id>`; without `session` it shows the Mend
  view.
- CLI: `mend login` writes the connection the extension reads; `mend ssh setup` is the terminal's
  `Mend: Set up workspace SSH`; `mend attach <id8>` is what the takeover offers for harnesses it
  cannot continue.
- Docs: `apps/docs/src/content/docs/clients/vscode.md`.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, `mend login --url <web>` has been run in the same `XDG_CONFIG_HOME` the
  editor would use, and `<project>` is adopted.
- The server reports a workspace SSH gateway (see [Workspace SSH](./workspace-ssh.md)).
- The verify stack has no VS Code harness, and the extension is not on the Marketplace. Every
  step below except the build is `not drivable yet`: it needs a VS Code 1.100+ window with this
  `.vsix` installed and Microsoft's Remote - SSH, driven by a person or a VS Code test runner the
  stack does not have. A run reports each of them with that reason.

- **Build and package (drivable).** Run `pnpm --filter mend build`, then
  `pnpm --filter mend package`. Both exit `0`; `apps/vscode/dist/extension.js` and
  `apps/vscode/mend-0.1.0.vsix` exist. `code --install-extension apps/vscode/mend-0.1.0.vsix` is the
  install step (not drivable yet: no VS Code in the stack).
- **Connect.** `not drivable yet`. Run `Mend: Connect to server`. Two inputs titled `Connect Mend`
  ask `Mend server URL`, then
  `Access token. Leave empty when the local server does not require one.`. End state:
  `Connected to Mend at <web>.`; the URL is saved as `mend.serverUrl`, the token in VS Code's secret
  storage. With the CLI's connection already on file there is nothing to do.
- **View.** `not drivable yet`. Open the Mend view. End state: the tree shows `Needs you` (only
  while a session waits) and `Projects`, each project with its default branch as description and
  each session with its status; the status bar shows `Mend: <project> · <n> sessions`.
- **Adopt.** `not drivable yet`. Run `Mend: Adopt a project…`; the input titled
  `Adopt a project` asks `Git clone URL` (placeholder `https://github.com/owner/repository.git`),
  then `Project name`. End state: a notification `Adopting <name>…`, then `Adopted <name>.`, and
  `mend projects` lists it.
- **New session.** `not drivable yet`. Run `Mend: New Session…` (or `+` in the view). The quick
  pick offers `$(terminal) Workbench`, `$(sparkle) Claude agent`, `$(sparkle) Codex agent` and
  `$(settings-gear) Agent with options…`. The quick Claude and Codex choices ask
  `What should the agent do? Empty opens the harness without a prompt.`. `Agent with options…`
  asks `What should the session do? Leave empty to open the harness without a prompt.`, then
  `Harness` (`Claude`, `Codex`, `opencode`, `pi`). `Model` is asked only when the catalog offers
  models, and `Thinking` only when the selected model offers more than one effort choice.
  `Permissions` (`Skip permission prompts`, `Ask before acting`) follows; a new worktree also asks
  `Base branch or commit`. End state: a progress notification
  `Starting <harness>…`, then the workspace opens in a Remote - SSH window, and
  `mend sessions --project <project> --json` lists the new session.
- **New session in this worktree.** `not drivable yet`. On a session row run
  `Mend: New session in this worktree…`. End state: a second session in the same worktree
  (`mend worktrees --project <project>` lists both under one worktree).
- **New worktree without an agent.** `not drivable yet`. Run
  `Mend: New worktree without an agent…`; it asks `Name this manual change`, then
  `Base branch or commit`. End state: the worktree exists (`mend worktrees`) and opens.
- **Open a session.** `not drivable yet`. Click a live session. End state: on first use the modal
  `Set up workspace SSH?` with `Set up`; then a Remote - SSH window on
  `ssh-remote+<user prefix>-<workspace id>@<host>` at `/workspace/repo`. A settled session first
  asks `<session> has no live workspace.` and resumes it as a workbench shell. Without Remote - SSH
  it offers `Install Remote SSH` or `Copy code command`. Without a gateway it says
  `This Mend deployment exposes no workspace SSH gateway.` and opens nothing.
- **Take over.** `not drivable yet`. With a `mend claude … --detach` session running, run
  `Mend: Take over session in the editor` on it. End state: the modal
  `Take over <session> in the editor?` with `Take over`, the notification `Taking over <session>…`,
  the agent stopped and a shell holding the workspace, and in the workspace window a terminal
  running `claude --resume <id>` (or `codex resume <id>`; `claude --continue` or
  `codex resume --last` without a known id). For another harness it says
  `Mend cannot continue a <harness> conversation by hand; attach from a terminal instead: mend attach <id8>`.
- **Stop.** `not drivable yet`. Run `Mend: Stop session` on a live session. End state: the modal
  `Stop <session>?` (`The worktree and reviewable change remain.`) with `Stop session`; then
  `mend sessions --project <project> --all --json` shows it settled.
- **Open in Mend.** `not drivable yet`. Run the session row's `Mend: Open in Mend` action. End
  state: the browser opens `<web>/sessions/<id>`. To open the current folder's project, run
  `Mend: Open in Mend` from the Command Palette in that project's folder. End state:
  `<web>/projects/<id>`. From a session workspace the palette opens its session instead; with
  no current session or project it opens `<web>`. Projects have no row action for this command.
- **URI.** `not drivable yet`. Open `vscode://sealant-sh.mend/open?session=<id>`. End state: the same
  as opening the session, with the takeover question when Mend runs its agent elsewhere.
- **Proof.** For the build: the two commands with stdout, stderr and exit code, and a listing of
  `apps/vscode/mend-0.1.0.vsix`. For the rest, report `not drivable yet: no VS Code harness in the
  verify stack` per step; the CLI's `mend sessions --json` and `mend worktrees --json` are the second
  view once a person has driven a step.

## Gotchas

- The package is named `mend`, not `@mend/vscode`: filter it as `pnpm --filter mend`.
- The extension does not use the web app's terminal embed (`/tty-embed`) or `/api/tty`: no source
  under `apps/vscode/src` names either. Its terminal is VS Code's integrated terminal inside the SSH
  workspace. The embed is the phone's WebView page; it is mapped, and drivable in a browser, in
  [Mobile app](./mobile.md) (`mobile-terminal-embed`).
- The extension never opens the worktree's path on the Mend host. `Mend: Copy worktree path` copies
  the server-side path; nothing else uses it.
- In a per-person workspace the editor connects as the workspace's launcher; a workspace someone
  else launched in a shared worktree is theirs to open.
- A takeover ends the running agent before the editor resumes it. Cancelling the SSH setup or the
  confirmation leaves the agent running. Only `claude` and `codex` can be taken over.
- `mend.serverUrl` and the CLI's token: the CLI's token is used only while `mend.serverUrl` is empty
  or equals the CLI's URL. A token saved through `Mend: Connect to server` lives in VS Code's secret
  storage, not in `cli.json`.
- The view and the status bar are VS Code UI: there are no ARIA handles to drive from Playwright,
  and the extension host has no debugging port in the verify stack.
