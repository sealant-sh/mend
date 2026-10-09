# Mend verification map

This directory is the maintained source for verifying every user-facing feature of Mend. Read this
index before driving Mend, find the feature in the coverage table, then use its file as the recipe.
The map was written from source: the command catalog in `apps/cli/src/help.ts` and the CLI in
`apps/cli/src`, the web routes and components in `apps/web/src`, the TUI in
`apps/cli/src/dashboard*` and `apps/cli/src/review.tsx`, the desktop, mobile, VS Code and T3 gateway
apps, the docs site in `apps/docs/src/content/docs`, and the ADRs in `docs/adr/`. It has not been
driven live yet. The first live pass happens when the `verify` skill's Launch section exists, which
waits on the 0.36 feature "Verify Mend in Mend".

## Baseline preconditions

- The stack under test comes from the `verify` skill's Launch section, which is pending "Verify Mend
  in Mend": the full stack from source, inside a Mend session. Until that section exists, no recipe
  here has a supported launch, and a run reports every feature as unreachable with that reason.
- The instance has at least one account, and the web app answers at the URL Launch names (written
  `<web>` below; the CLI's own default is `http://localhost:3105`).
- The `mend` CLI under test is on `PATH` and signed in to that instance: `mend login --url <web>`,
  then `mend doctor` prints one line per fact with nothing left unfinished that the recipe needs.
- Launch supplies a disposable Git repository the server can clone (written `<repo-url>`), and a
  project name for it (written `<project>`). Adoption takes network Git URLs only: local paths and
  `file://` URLs are refused.
- Recipes that run `mend claude` or `mend codex` need that provider connected
  (`mend connect claude`, `mend connect codex`). Recipes that need no inference use `mend run`.
- Landing needs a GitHub origin and `mend connect github` to open a pull request. With any other
  origin the push happens and the pull request is reported as unavailable.
- Never drive an instance this verification run did not start. Never drive the owner's own Mend.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Web steps use Playwright through ARIA roles and accessible names:
  `page.getByRole(role, { name })`. Prefer roles and names over CSS selectors, text matches or DOM
  position. Where a control has no stable accessible name, its feature file says so in Gotchas; that
  is a finding to fix in the product, not a reason to invent a selector. A name that comes only from
  a placeholder is one Playwright finds, but it is listed in Gotchas as a missing label.
- Never wait for `networkidle`. Every workbench page holds an open SSE stream (`/api/events`,
  `apps/web/src/lib/workbench-events.ts`), so the network never goes idle. Wait for the role, name
  or text the step names.
- CLI steps are exact `mend` commands. Treat every command as literal; keep quoted names and flags
  unchanged. Angle-bracketed words are values the run fills in.
- `mend codex`, `mend claude`, `mend attach`, `mend continue`, `mend service connect` and
  `mend service logs` hold the terminal. Run them in their own PTY (tmux or similar); a harness
  launch may pass `--detach` instead. Never run them in a plain pipe.
- TUI steps run the dashboard (`mend ui`, or bare `mend`) in a tmux session sized like a real
  terminal (`tmux new-session -d -s <name> -x 200 -y 50`), send keys with
  `tmux send-keys -t <name> <key>`, and read the screen with `tmux capture-pane -p -t <name>`. Keys
  and the strings to wait for come from `apps/cli/src/dashboard*` and `apps/cli/src/review.tsx`. The
  dashboard needs Node 26 or newer.
- Desktop steps start the Electron app with a remote debugging port and attach Playwright through
  CDP (`chromium.connectOverCDP("http://127.0.0.1:<port>")`), then use ARIA roles and names as on
  the web.
- Mobile steps run the Expo app on the web (`pnpm --filter @mend/mobile web`) in Playwright at a
  390x844 viewport, and use ARIA roles and names as on the web. Native-only behavior (keychain,
  camera, push) is reported unreachable on the web build.
- VS Code and Slack steps are `not drivable yet`: their files list entry points and observable end
  states only, and say why.
- Web sign-in goes through `/login`: the textbox `Email`, the password field labelled `Password`,
  and the button `Sign in`. Sign-in calls outside a browser must carry an `Origin` header naming the
  instance's own origin: the auth layer rejects requests from origins outside its trusted list
  (`packages/auth/src/auth.ts`, `trustedOrigins`).
- Stop only what the run started, by the PID or session id it recorded. `pkill -f` with an
  unbracketed pattern matches the shell running it and kills that shell; if a pattern is
  unavoidable, bracket one character (`pkill -f '[m]end server'`).
- Restore seeded state after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Proof follows Mend's language contract: write what was observed, never a verdict. "Completed ·
  observed", "pushed", "pull request #12 · open · observed" are facts; "works", "safe to merge" and
  "ready to merge" are not proof and never appear in a report.
- Capture the user action and the resulting state, not only the final screen.
- Web proof includes an ARIA snapshot (`await page.locator("body").ariaSnapshot()`) and a screenshot
  with the page heading visible.
- CLI proof includes the command, stdout, stderr and exit code.
- Mutation proof includes a second, read-only view of the stored result: a reload of the page, or a
  listing command such as `mend projects`, `mend sessions --all --json` or `mend worktrees --json`.
- Record the feature file, sub-feature ID and entry point (web, CLI, TUI, desktop or mobile) with
  every artifact, under the evidence directory the `verify` skill's Evidence section names (pending
  with Launch).
- Report an unreachable path with the attempted step and the unmet precondition, for example
  "provider not connected" or "origin is not on GitHub".
- Do not report an entry point as verified through a different one. A change landed with `mend land`
  does not prove the web `Push and open pull request` button.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It
then uses exactly four H2 sections, in this order.

1. `Sub-features` lists short IDs, one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point on every surface: web, CLI, TUI,
   desktop, mobile, VS Code and Slack.
3. `Driving it with verify` starts with `Preconditions:` and uses labelled bullets that pair each
   user action with an exact Playwright call, `mend` command or tmux key and the result a user can
   observe. VS Code and Slack steps are marked `not drivable yet`, with the reason.
4. `Gotchas` lists traps that can waste or invalidate a run, and every control the recipe needs that
   has no stable accessible name.

Keep implementation details out of the map. Name only user paths, stable handles, required state,
commands and observable proof.

## Features

One row per user-facing feature, found by sweeping the 86 commands in `apps/cli/src/help.ts`, every
route under `apps/web/src/routes` (settings and project setup included), the TUI dashboard and
review screen, the desktop, mobile and VS Code apps, the T3 gateway, Slack (ADR 0006), `mend.toml`,
every page under `apps/docs/src/content/docs`, and the ADRs in `docs/adr/`. A feature that appears
on several surfaces is one row. `not mapped` rows say why, so a gap is visible rather than silent.

Totals: 58 features, 51 mapped, 7 not mapped.

### The core loop

| Feature          | File                                         | Surfaces                                        | Status |
| ---------------- | -------------------------------------------- | ----------------------------------------------- | ------ |
| adopt-project    | [adopt-project.md](./adopt-project.md)       | web, CLI, TUI, mobile, VS Code                  | mapped |
| start-session    | [start-session.md](./start-session.md)       | web, CLI, TUI, desktop, mobile, VS Code, Slack  | mapped |
| review-change    | [review-change.md](./review-change.md)       | web, TUI, desktop, mobile                       | mapped |
| send-review-back | [send-review-back.md](./send-review-back.md) | web, CLI, TUI, desktop, mobile                  | mapped |
| land-change      | [land-change.md](./land-change.md)           | web, CLI, desktop, mobile (observe only), Slack | mapped |
| services         | [services.md](./services.md)                 | web, CLI, TUI, desktop                          | mapped |

### Access and identity

| Feature           | File                                           | Surfaces                           | Status |
| ----------------- | ---------------------------------------------- | ---------------------------------- | ------ |
| sign-in           | [sign-in.md](./sign-in.md)                     | web, CLI, desktop                  | mapped |
| pairing-devices   | [pairing-devices.md](./pairing-devices.md)     | web, CLI, mobile                   | mapped |
| provider-accounts | [provider-accounts.md](./provider-accounts.md) | web, CLI, desktop                  | mapped |
| git-access        | [git-access.md](./git-access.md)               | web, CLI                           | mapped |
| workspace-ssh     | [workspace-ssh.md](./workspace-ssh.md)         | CLI, VS Code                       | mapped |
| models            | [models.md](./models.md)                       | web, CLI, desktop, mobile, VS Code | mapped |

### Personal setup

| Feature      | File                                 | Surfaces             | Status |
| ------------ | ------------------------------------ | -------------------- | ------ |
| dotfiles     | [dotfiles.md](./dotfiles.md)         | web, CLI             | mapped |
| secret-files | [secret-files.md](./secret-files.md) | web, CLI             | mapped |
| git-author   | [git-author.md](./git-author.md)     | web, CLI             | mapped |
| skills       | [skills.md](./skills.md)             | web, CLI             | mapped |
| agent-memory | [agent-memory.md](./agent-memory.md) | CLI                  | mapped |
| pi-profile   | [pi-profile.md](./pi-profile.md)     | CLI                  | mapped |
| appearance   | [appearance.md](./appearance.md)     | web, desktop, mobile | mapped |

### Project setup and customization

| Feature             | File                                               | Surfaces | Status |
| ------------------- | -------------------------------------------------- | -------- | ------ |
| project-environment | [project-environment.md](./project-environment.md) | web, CLI | mapped |
| cluster-bindings    | [cluster-bindings.md](./cluster-bindings.md)       | web, CLI | mapped |
| workspace-images    | [workspace-images.md](./workspace-images.md)       | web      | mapped |
| automatic-install   | [automatic-install.md](./automatic-install.md)     | web      | mapped |
| hot-sessions        | [hot-sessions.md](./hot-sessions.md)               | web      | mapped |
| project-settings    | [project-settings.md](./project-settings.md)       | web      | mapped |
| references-folders  | [references-folders.md](./references-folders.md)   | web, CLI | mapped |
| mend-toml           | [mend-toml.md](./mend-toml.md)                     | CLI, web | mapped |

### Sessions

| Feature                 | File                                                       | Surfaces                       | Status |
| ----------------------- | ---------------------------------------------------------- | ------------------------------ | ------ |
| now-and-sessions        | [now-and-sessions.md](./now-and-sessions.md)               | web, CLI, mobile, desktop      | mapped |
| attach-resume           | [attach-resume.md](./attach-resume.md)                     | CLI, web, TUI, desktop, mobile | mapped |
| session-shell           | [session-shell.md](./session-shell.md)                     | CLI, web, desktop, mobile      | mapped |
| worktrees               | [worktrees.md](./worktrees.md)                             | web, CLI, TUI, VS Code         | mapped |
| workspace-replace       | [workspace-replace.md](./workspace-replace.md)             | web, CLI                       | mapped |
| pull-change             | [pull-change.md](./pull-change.md)                         | CLI                            | mapped |
| repositories-in-session | [repositories-in-session.md](./repositories-in-session.md) | CLI (in the workspace), web    | mapped |
| capture-and-save        | [capture-and-save.md](./capture-and-save.md)               | web, CLI                       | mapped |
| observed-agents         | [observed-agents.md](./observed-agents.md)                 | CLI (in the workspace), web    | mapped |

### Organization and sharing

| Feature          | File                                         | Surfaces                                | Status |
| ---------------- | -------------------------------------------- | --------------------------------------- | ------ |
| organization     | [organization.md](./organization.md)         | web, CLI                                | mapped |
| shared-control   | [shared-control.md](./shared-control.md)     | web, CLI, desktop, mobile               | mapped |
| per-person-homes | [per-person-homes.md](./per-person-homes.md) | web, CLI, TUI, desktop, mobile, VS Code | mapped |
| operator         | [operator.md](./operator.md)                 | CLI, web                                | mapped |
| exposure         | [exposure.md](./exposure.md)                 | CLI, web                                | mapped |

### This machine: the server and the CLI

| Feature   | File                           | Surfaces | Status |
| --------- | ------------------------------ | -------- | ------ |
| server    | [server.md](./server.md)       | CLI      | mapped |
| doctor    | [doctor.md](./doctor.md)       | CLI, web | mapped |
| uninstall | [uninstall.md](./uninstall.md) | CLI      | mapped |
| cli       | [cli.md](./cli.md)             | CLI      | mapped |
| tui       | [tui.md](./tui.md)             | TUI      | mapped |

### Clients and integrations

| Feature     | File                             | Surfaces             | Status                                     |
| ----------- | -------------------------------- | -------------------- | ------------------------------------------ |
| desktop-app | [desktop.md](./desktop.md)       | desktop              | mapped                                     |
| mobile-app  | [mobile.md](./mobile.md)         | mobile               | mapped                                     |
| vscode      | [vscode.md](./vscode.md)         | VS Code              | mapped; drive steps not drivable yet       |
| slack       | [slack.md](./slack.md)           | Slack, web           | mapped; Slack drive steps not drivable yet |
| t3-gateway  | [t3-gateway.md](./t3-gateway.md) | t3code clients, HTTP | mapped                                     |

### Not mapped

| Feature                   | Surfaces                                           | Status and reason                                                                                                                                                    |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issue-queue               | web (`/queue`, `/issues/$issueId`, `/runs/$runId`) | not mapped: the retired issue queue ("the queue is gone", AGENTS.md). The routes still answer by URL, but no navigation reaches them.                                |
| context-packs-handoffs    | none                                               | not mapped: planned, not built (`reference/feature-status`: context items, packs, snapshots and editable handoffs are planned).                                      |
| agent-protocol-sessions   | none                                               | not mapped: the process kind is reserved and nothing launches one yet.                                                                                               |
| mend-toml-setup-preview   | none                                               | not mapped: `mend.toml` declares Services only (`[service.<name>]`); it has no setup or preview key. Setup commands live in the workspace image (workspace-images).  |
| multi-tenancy             | server                                             | not mapped: `MEND_TENANCY=multi` refuses to start until its gate passes. Reading the gate is mapped (exposure, `mend operator gate`).                                |
| scoped-device-permissions | none                                               | not mapped: planned; paired devices have ordinary authenticated access today.                                                                                        |
| kubernetes-deployment     | Helm chart                                         | not mapped: an operator deployment that needs a Kubernetes cluster, not a product surface. What it changes for users is mapped (cluster-bindings, per-person-homes). |

The marketing site (`apps/marketing`) and the docs site (`apps/docs`) are publications about Mend,
not features of it, and are not rows.
