# Adopt a project

Adoption brings a network Git repository into Mend's central store as a project. Sessions then run
in git worktrees of it: a new name creates one, an existing name joins it. A user pastes a Git URL
on the web Projects page or runs `mend adopt`, chooses how the store fetches (Mend key, bridge, or
ambient) and who sees it (only them, or their organization), and then finds the project in the
directory and on its own page.

## Sub-features

- `adopt-web` adopts a Git URL from the Projects page's adopt panel.
- `adopt-invalid-url` refuses a URL that is not a cloneable network URL, with the reason, before
  anything is sent.
- `adopt-access` picks the git access for this one adoption: `mend key`, `bridge` or `ambient`.
- `adopt-visibility` picks `only you` (private, the default) or `everyone in <organization>`
  (shared).
- `adopt-cli` adopts from the terminal with `mend adopt`.
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
- Mobile: the `Adopt project` screen. VS Code: the `Mend: Adopt a project…` command. Desktop: the
  sidebar has no adopt control and points at `mend adopt` when no project exists. None of these are
  driven by this map.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and the browser is signed in.
- `<repo-url>` is a disposable repository the server can clone with `ambient` access, and no project
  named `<project>` exists.
- `mend projects` does not list `<project>`.

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
- **Read-only second view.** Run `mend projects`. Both `<project>` and `<project>-cli` are listed.
- **Proof.** Capture the directory and the project page. Save
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` for `/projects`
  filtered to `<project>` and for the project page, plus the `mend adopt` and `mend projects`
  transcripts.

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
- Cleanup has no single command in this map: removing a project is not in `help.ts`. Record the
  leftover projects in the run notes rather than inventing a removal path.
