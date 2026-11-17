# Adopt a project

Adoption brings a network Git repository into Mend's central store as a project. Sessions then run
in git worktrees of it: a new name creates one, an existing name joins it. A user pastes a Git URL
on the web Projects page or runs `mend adopt`, chooses how the store fetches (Mend key or bridge)
and who sees it (only them, or their organization), and then finds the project in the directory and
on its own page. The dashboard offers to adopt the checkout it was opened in, the phone adopts from
its Adopt project screen, and VS Code from a command.

## Sub-features

- `adopt-web` adopts a Git URL from the Projects page's adopt panel.
- `adopt-invalid-url` refuses a URL that is not a cloneable network URL, with the reason, before
  anything is sent.
- `adopt-access` picks the git access for this one adoption: `mend key` or `bridge`. `ambient` is
  gone (0.36) and `mend adopt --auth ambient` is refused.
- `adopt-visibility` picks `only you` (private, the default) or `everyone in <organization>`
  (shared).
- `adopt-cli` adopts from the terminal with `mend adopt`.
- `adopt-tui` adopts the checkout's own origin from the dashboard's offer, with an access mode.
- `adopt-mobile` adopts from the phone: a repository the server's `gh` lists, or a typed clone URL.
- `adopt-vscode` adopts with `Mend: Adopt a project…`.
- `projects-directory` lists adopted projects and filters them by name, origin or store path.
- `project-page` opens one project with its Worktrees and Setup tabs.

## How to get to it (user POV)

- Web: the rail's `Projects` (`/projects`), the expanded rail's `Adopt a repository` link while
  nothing is adopted, or the `Adopt a repository` link in the first-run checklist on Sessions (`/`).
  Each opens `/projects`.
- Web: on the Projects page (`/projects`), choose the `Adopt a repository` button.
- CLI: run `mend adopt [git-url] [--name <name>] [--auth mend-key|bridge] [--private|--shared]`.
  With no URL, Mend uses the current checkout's origin.
- CLI: `mend projects` lists adopted projects with their live sessions.
- TUI: run `mend ui` (or bare `mend`) inside a checkout whose origin is a network Git URL that no
  project has. Once the workbench loads, a box titled `adopt this repository URL?` offers it, once
  per dashboard run.
- Desktop: no adopt control. With no project, the sidebar reads
  `no projects — adopt one with mend adopt`.
- Mobile: the Projects tab's `Adopt` button opens the `Adopt project` screen (`/adopt`).
- VS Code: the `Mend: Adopt a project…` command asks for the Git clone URL, then the project name.
- Slack: no adopt. A Slack request picks among projects already adopted (ADR 0006).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and the browser is signed in.
- Say which account each surface is signed in as. The simplest setup is one account on both: run
  `mend login --url <web>` and approve on `/authorize` in the signed-in browser. The verify stack's
  handover signs both surfaces in as its first account. When the two surfaces are two accounts, a
  project adopted `only you` is visible to its creator only, so a check on one surface sees the
  other surface's adoption only when it was adopted `everyone in <organization>`.
- `<repo-url>` is a disposable HTTP(S) repository the server can clone, and no project named
  `<project>` exists. Either mode clones an HTTP(S) remote with no signer, so the default `mend key`
  needs nothing added on the git host.
- `mend projects` does not list `<project>`.
- TUI steps: `<repo-url-2>` is a second disposable HTTP(S) repository the server can clone, and no
  project has it as its origin. The dashboard needs Node 26 or newer.
- Mobile steps: the Expo web build runs (`pnpm --filter @mend/mobile web`) at the URL it prints
  (written `<mobile-web>`), in Playwright at 390x844, and is paired with this instance (see
  [Pairing devices](./pairing-devices.md)). The instance must accept that origin: the API answers
  cross-origin calls only from `APP_URL` and the `MEND_ALLOWED_ORIGINS` list
  (`packages/network/src/public-network.ts`). Launch has to set that; this map has not established
  it.

- **Open Projects.** Go to the directory. Run `await page.goto("<web>/projects")`. The heading
  `Projects` is visible (`page.getByRole("heading", { name: "Projects", exact: true })`).
- **Open the adopt panel.** Choose `Adopt a repository`. Run
  `await page.getByRole("button", { name: "Adopt a repository" }).click()`. The dialog
  `page.getByRole("dialog", { name: "Adopt a repository" })` opens with the combobox `Repository`
  (`dialog.getByRole("combobox", { name: "Repository" })`) focused. With no GitHub login on the
  server its list reads the status
  `GitHub search is off: the Mend server has no GitHub login · paste any git URL`.
- **Refuse a local path.** Type a path that is not a network URL. Run
  `await dialog.getByRole("combobox", { name: "Repository" }).fill("/tmp/not-a-url")`. The combobox
  reports `aria-invalid="true"`, the line under the form reads
  `Use an HTTP(S), SSH, SCP-style, or git:// repository URL. Local paths and file:// URLs are not supported.`
  and `Adopt` is disabled. While the combobox's list is open, the ARIA snapshot holds only the
  combobox (see Gotchas); read the line and `Adopt` from a screenshot, or after the list closes.
- **Enter the URL and name.** Fill the `Repository` combobox with `<repo-url>` and the `Name` field
  with `<project>`. The line is gone and `Adopt` is enabled.
- **Pick access and visibility.** The group `Git access` has `Mend's key` and `Your computer's key`.
  Run
  `await dialog.getByRole("group", { name: "Git access" }).getByRole("button", { name: "Mend's key" }).click()`;
  the dialog shows the account's Mend key card, or `Create Mend's key` when it has none. The group
  `Visible to` has `Only you` pressed by default; leave it.
- **Adopt.** Run `await dialog.getByRole("button", { name: "Adopt", exact: true }).click()`. The
  dialog shows the clone's progress, then its title reads `<project> adopted` with `Done` and
  `Open project`.
- **Confirm in the directory.** Run
  `await page.getByRole("searchbox", { name: "Filter projects by name, origin or path" }).fill("<project>")`.
  The status beside it reads `1 of <n>`, and the table lists one row whose first cell holds the link
  named exactly `<project>`
  (`page.getByRole("main").getByRole("link", { name: "<project>", exact: true })`). Scope it to
  `main`: the sidebar can repeat projects as links.
- **Open the project.** Choose that link. The project page shows the heading `<project>`
  (`page.getByRole("heading", { name: "<project>", exact: true, level: 1 })`), a line
  `<origin> · <default branch> · <visibility>`, and the navigation `<project> project` with the
  links `Sessions <n>`, `Worktrees <n>`, `Resources <n>`, `Skills <n>` and `Settings`. The landing
  tab is Sessions (the region `Sessions in <project>`); the region `Worktrees` is on
  `/projects/<id>/worktrees`, reached by the `Worktrees <n>` link.
- **CLI entry.** Adopt a second copy under another name. Run
  `mend adopt <repo-url> --name <project>-cli --auth mend-key`. Exit code `0`, and stdout starts
  with `✓ adopted · <project>-cli · <store path>`, then `  default branch <branch>`,
  `  visible to only you` and `  git auth mode mend key (configured for SSH remotes)`.
- **CLI refusal.** Run `mend adopt /tmp/not-a-url --name nope`. Exit code `1` and stderr starts with
  `mend: ` and states why the URL cannot be cloned. `mend projects` does not list `nope`.
- **CLI: ambient is refused.** Run `mend adopt <repo-url> --name nope --auth ambient`. Exit code `1`
  and stderr reads
  `mend: Mend no longer has an ambient git mode: a packaged server holds no git or ssh credential of its own.`
  followed by the two modes to use instead. Nothing is adopted.
- **TUI: the offer.** Clone the second repository into a directory named for the project, and open
  the dashboard there. Run `git clone <repo-url-2> /tmp/verify-tui/<project>-tui`, then
  `tmux new-session -d -s mend-adopt -x 200 -y 50 -c /tmp/verify-tui/<project>-tui 'mend ui'`. Once
  the workbench loads, `tmux capture-pane -p -t mend-adopt` shows a box titled
  `adopt this repository URL?` with `<project>-tui · not in the store yet`, the URL, the line
  `auth  ▸ mend-key · bridge` (the marker starts on the account's saved mode, `mend-key` when it is
  unknown), the hint `your Mend key · add its public half on the git host`, and
  `enter adopt · ←→ auth mode · esc not now`. The footer reads the same.
- **TUI: pick the access.** Run `tmux send-keys -t mend-adopt Right`. The marker moves to `▸ bridge`
  and the hint reads ``your own ssh-agent, relayed while `mend keys share` runs``. Run
  `tmux send-keys -t mend-adopt Left` to come back to `▸ mend-key`. The choice wraps at both ends.
- **TUI: adopt.** Run `tmux send-keys -t mend-adopt Enter`. The status line reads
  `adopting <project>-tui · cloning into the store · <n>s elapsed`, then
  `adopted · <project>-tui · w starts a worktree`, and the projects section names `<project>-tui` as
  the selected project. Quit with `tmux send-keys -t mend-adopt q`.
- **Mobile: open the screen.** Run `await page.goto("<mobile-web>/projects")`. The tab `Projects` is
  selected (`page.getByRole("tab", { name: "Projects" })`) and the meta line reads `<n> adopted`.
  Tap `Adopt`: `await page.getByText("Adopt", { exact: true }).click()` (no button role, see
  Gotchas). The URL becomes `/adopt` and the heading `Adopt project` is visible
  (`page.getByRole("heading", { name: "Adopt project" })`).
- **Mobile: refuse a local path.** Run
  `await page.getByRole("textbox", { name: "https://github.com/owner/repo.git" }).fill("/tmp/not-a-url")`.
  A line under the field states why the URL cannot be cloned, and a bar at the bottom shows the
  source, the textbox `project-name` and `Adopt`, faded.
- **Mobile: adopt.** Run
  `await page.getByRole("textbox", { name: "https://github.com/owner/repo.git" }).fill("<repo-url>")`,
  then `await page.getByRole("textbox", { name: "project-name" }).fill("<project>-mobile")`, then
  tap the bar's `Adopt`. It reads `Adopting…` with the status `cloning into the store`; on success
  the screen closes and the Projects tab lists `<project>-mobile` with its default branch. A refusal
  shows `failed` and the server's words.
- **VS Code: adopt.** `not drivable yet`: this map has no VS Code harness. The user runs
  `Mend: Adopt a project…`, types the URL into the `Git clone URL` box (it refuses a non-network URL
  as they type), accepts or edits the `Project name` box, and sees the notification
  `Adopted <name>.` and the project in the Mend tree.
- **Read-only second view.** Run `mend projects`. It lists `<project>-cli` and `<project>-tui` (the
  CLI's own adoptions). It lists `<project>` only when the CLI and the browser are the same account,
  and `<project>-mobile` only when the phone is paired as the CLI's account; otherwise their absence
  is the `only you` rule, not drift. Each surface's own listing (the web directory, the phone's
  Projects tab) shows what it adopted.
- **Proof.** Capture the directory and the project page. Save
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` for `/projects`
  filtered to `<project>` and for the project page, the TUI offer and the adopted line
  (`tmux capture-pane -p`), the mobile `/adopt` screen and the Projects tab after it, plus the
  `mend adopt` and `mend projects` transcripts.

## Gotchas

- `Adopt a repository` names a link in the first-run checklist and the expanded rail, and a button
  on the Projects page. Ask for the role as well as the name.
- The `Adopt` button's name is a prefix of `Adopt a repository`. Pass `exact: true`.
- The panel is a `dialog` named `Adopt a repository`
  (`apps/web-old/src/components/projects-index/adopt-dialog.tsx`). While the `Repository` combobox's
  list is open, the box's ARIA snapshot (17 Nov) held only the combobox, its status and `Dismiss`:
  the refusal line and `Adopt` were in the screenshot, not the snapshot. The refusal line is the
  form's `role="alert"` paragraph in source; that it is exposed as an alert once the list closes is
  not confirmed by a capture.
- The handles of the steps after the refusal (`Name`, `Git access`, `Visible to`, the adopted state)
  come from source, not from a box capture: the box flow adopts nothing.
- A project's directory row is a table `row` whose name is the whole row; the link inside its first
  cell is named exactly by the project's name (box, 17 Nov). Match it with `exact: true`, so
  `<project>-cli` does not match, and scope it to `page.getByRole("main")`.
- Accessible names match as case-blind substrings unless `exact: true`. `Worktrees` matches
  `No worktrees yet`. On a project page two links are named `Projects` (the sidebar's and the page
  header's): scope to `main` or the `Primary` navigation.
- `Create Mend's key` creates the user's Mend key and shows its public key. A private repository
  then needs that key on the git host before an SSH clone succeeds. Use a disposable public HTTP(S)
  repository unless the run is about git access: neither mode signs an HTTP(S) clone.
- Project names are unique within an organization. Rerunning the recipe needs a fresh `<project>` or
  cleanup between runs.
- Removing a project has no CLI command. On the web, the project's Setup tab has `Remove project…`,
  and a second click confirms (`Really remove project and store copy?`); see
  [Project settings](./project-settings.md). Clean up between runs that way, or use a fresh
  `<project>` name.
- The dashboard offers adoption only when no project matches the checkout: not by origin, and not by
  a project name equal to the checkout's directory name (`matchProjectByCwd`,
  `apps/cli/src/shared.ts:420`). That is why the TUI step needs a repository no project has, cloned
  into a directory whose name is not taken. The offer is raised once per run; after `esc` the status
  line reads `not adopted · use mend adopt <url> any time` and the run never offers again.
- The TUI, mobile and VS Code adoptions offer no visibility choice, and the TUI offers no name: the
  dashboard sends a name, the source and an access mode (`apps/cli/src/dashboard-adoption.ts:50`),
  the phone a name and the source (`apps/mobile/src/data/live.ts:802`), and VS Code a name and the
  source (`apps/vscode/src/extension.ts:293`). `adopt-visibility` exists on the web and CLI only,
  and `adopt-access` on the web, CLI and TUI. That is a product gap.
- TUI status lines clear five seconds after they appear (`apps/cli/src/dashboard.tsx:641`); capture
  the pane right after the key. The busy line with its elapsed seconds stays until the call returns.
- On the phone, `Adopt` (on the Projects tab and in the adopt bar) is a pressable with no role and
  no label (`apps/mobile/src/components/button.tsx`), so it is not a `button` to Playwright. Drive
  it by its text. That is a finding.
- The phone's fields have no labels; their names come from placeholders:
  `Search github — empty shows your latest`, `https://github.com/owner/repo.git` and `project-name`.
  The repository rows the server's `gh` lists have no role or name; select one by its `owner/name`
  text. Both are findings.
- On the phone, an invalid URL or name only fades `Adopt`; it stays tappable and does nothing. The
  refusal line is plain text, not `role="alert"`.
- The phone's GitHub list needs `gh` signed in on the server machine. Without it the screen reads
  `GitHub discovery is unavailable on the server` and only the typed URL path remains.
- Phone handles that are only text can match more than one element. When one does, add
  `.filter({ visible: true })` rather than picking by position.

## Removed projects

Drive retention from
[T3 gateway → Restorable project removal](./t3-gateway.md#restorable-project-removal). Observed on
2026-10-30: removing `verify-fixture` through T3 Code omitted it from the web Projects list and
`mend projects --json`, while Projects → Removed projects and `mend projects removed --json`
retained it. `mend doctor` reported 102.0 kB kept indefinitely. Web Restore returned it to the
listed directory with zero live sessions. Evidence:
`/var/tmp/t3s1-retention-verify.3CxTpp/evidence/web/removed/`, `web/restore2/`,
`cli/removed-projects.stdout`, `cli/removed-removed.stdout` and `cli/removed-doctor.stdout`.
