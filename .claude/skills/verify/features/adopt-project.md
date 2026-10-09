# Adopt a project

Adoption brings a network Git repository into Mend's central store as a project. Sessions then run
in git worktrees of it: a new name creates one, an existing name joins it. A user pastes a Git URL
on the web Projects page or runs `mend adopt`, chooses how the store fetches (Mend key, bridge, or
ambient) and who sees it (only them, or their organization), and then finds the project in the
directory and on its own page. The dashboard offers to adopt the checkout it was opened in, the
phone adopts from its Adopt project screen, and VS Code from a command.

## Sub-features

- `adopt-web` adopts a Git URL from the Projects page's adopt panel.
- `adopt-invalid-url` refuses a URL that is not a cloneable network URL, with the reason, before
  anything is sent.
- `adopt-access` picks the git access for this one adoption: `mend key`, `bridge` or `ambient`.
- `adopt-visibility` picks `only you` (private, the default) or `everyone in <organization>`
  (shared).
- `adopt-cli` adopts from the terminal with `mend adopt`.
- `adopt-tui` adopts the checkout's own origin from the dashboard's offer, with an access mode.
- `adopt-mobile` adopts from the phone: a repository the server's `gh` lists, or a typed clone URL.
- `adopt-vscode` adopts with `Mend: Adopt a project…`.
- `projects-directory` lists adopted projects and filters them by name, origin or store path.
- `project-page` opens one project with its Worktrees and Setup tabs.

## How to get to it (user POV)

- Web: on the Now page (`/`), choose the `Adopt a repository` link beside Projects, or the
  `Adopt a repository` link in the first-run checklist when nothing is adopted yet. Both open
  `/projects`.
- Web: on the Projects page (`/projects`), choose the `Adopt a repository` button.
- CLI: run
  `mend adopt [git-url] [--name <name>] [--auth ambient|mend-key|bridge] [--private|--shared]`. With
  no URL, Mend uses the current checkout's origin.
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
- `<repo-url>` is a disposable repository the server can clone with `ambient` access, and no project
  named `<project>` exists.
- `mend projects` does not list `<project>`.
- TUI steps: `<repo-url-2>` is a second disposable repository the server can clone with `ambient`
  access, and no project has it as its origin. The dashboard needs Node 26 or newer.
- Mobile steps: the Expo web build runs (`pnpm --filter @mend/mobile web`) at the URL it prints
  (written `<mobile-web>`), in Playwright at 390x844, and is paired with this instance (see
  [Pairing devices](./pairing-devices.md)). The instance must accept that origin: the API answers
  cross-origin calls only from `APP_URL` and the `MEND_ALLOWED_ORIGINS` list
  (`packages/network/src/public-network.ts`). Launch has to set that; this map has not established
  it.

- **Open Projects.** Go to the directory. Run `await page.goto("<web>/projects")`. The heading
  `Projects` is visible (`page.getByRole("heading", { name: "Projects" })`).
- **Open the adopt panel.** Choose `Adopt a repository`. Run
  `await page.getByRole("button", { name: "Adopt a repository" }).click()`. The textbox
  `Repository Git URL` appears, and the same button now reads `Close`.
- **Refuse a local path.** Type a path that is not a network URL. Run
  `await page.getByRole("textbox", { name: "Repository Git URL" }).fill("/tmp/not-a-url")`. An alert
  appears (`page.getByRole("alert")`) and the `Adopt` button is disabled.
- **Enter the URL and name.** Run
  `await page.getByRole("textbox", { name: "Repository Git URL" }).fill("<repo-url>")` and
  `await page.getByRole("textbox", { name: "Project name (optional)" }).fill("<project>")`. The
  alert is gone and `Adopt` is enabled.
- **Pick access and visibility.** Run `await page.getByRole("button", { name: "ambient" }).click()`.
  The `ambient` button reports `aria-pressed="true"`. The `only you` button is pressed by default;
  leave it.
- **Adopt.** Run `await page.getByRole("button", { name: "Adopt", exact: true }).click()`. The
  button reads `Adopting…`, then the panel closes and the toggle reads `Adopt a repository` again.
- **Confirm in the directory.** Run
  `await page.getByRole("searchbox", { name: "Filter projects by name, origin or store path" }).fill("<project>")`.
  A count `1 of <n>` appears and a link whose name starts with `<project>` is listed
  (`page.getByRole("link", { name: new RegExp("^<project>") })`).
- **Open the project.** Choose that link. The project page shows the heading `<project>`, the
  navigation `Project` with links `Worktrees` and `Setup`, and the heading `Worktrees`
  (`page.getByRole("heading", { name: "Worktrees" })`).
- **CLI entry.** Adopt a second copy under another name. Run
  `mend adopt <repo-url> --name <project>-cli --auth ambient`. Exit code `0`, and stdout starts with
  `✓ adopted · <project>-cli · <store path>`, then `  default branch <branch>` and
  `  visible to only you`.
- **CLI refusal.** Run `mend adopt /tmp/not-a-url --name nope`. Exit code `1` and stderr starts with
  `mend: ` and states why the URL cannot be cloned. `mend projects` does not list `nope`.
- **TUI: the offer.** Clone the second repository into a directory named for the project, and open
  the dashboard there. Run `git clone <repo-url-2> /tmp/verify-tui/<project>-tui`, then
  `tmux new-session -d -s mend-adopt -x 200 -y 50 -c /tmp/verify-tui/<project>-tui 'mend ui'`. Once
  the workbench loads, `tmux capture-pane -p -t mend-adopt` shows a box titled
  `adopt this repository URL?` with `<project>-tui · not in the store yet`, the URL, the line
  `auth  ▸ ambient · mend-key · bridge`, the hint `the server machine's own git/ssh setup`, and
  `enter adopt · ←→ auth mode · esc not now`. The footer reads the same.
- **TUI: pick the access.** Run `tmux send-keys -t mend-adopt Right`. The marker moves to
  `▸ mend-key` and the hint reads
  `the machine's Mend deploy key · add its public half on the git host`. Run
  `tmux send-keys -t mend-adopt Left` to come back to `▸ ambient`.
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
- **Read-only second view.** Run `mend projects`. `<project>`, `<project>-cli`, `<project>-tui` and
  `<project>-mobile` are listed.
- **Proof.** Capture the directory and the project page. Save
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` for `/projects`
  filtered to `<project>` and for the project page, the TUI offer and the adopted line
  (`tmux capture-pane -p`), the mobile `/adopt` screen and the Projects tab after it, plus the
  `mend adopt` and `mend projects` transcripts.

## Gotchas

- `Adopt a repository` names a link on the Now page and a button on the Projects page. Ask for the
  role as well as the name.
- The `Adopt` button's name is a prefix of `Adopt a repository`. Pass `exact: true`.
- While the panel is closed it carries the `hidden` attribute, so its fields are not in the
  accessibility tree. Open it first.
- The panel's own title `Adopt a repository` is a plain paragraph, not a heading or a labelled form.
  Do not wait for a heading by that name.
- A project row's link name is the whole row: name, source, default branch, adoption date and live
  count. Match it with an anchored regular expression, not an exact string.
- Choosing `mend key` creates the user's Mend key and shows its public key. A private repository
  then needs that key on the git host before the clone succeeds. Use `ambient` with a disposable
  public repository unless the run is about git access.
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
