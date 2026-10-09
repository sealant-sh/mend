# Organization, members and project visibility

An organization is the tenant: it owns its members, projects, folders, references and audit log, and
every account belongs to exactly one. Registration closes after the first account, so everyone else
joins through a single-use invitation link that an owner prints with `mend invite` or creates in
Settings → Invitations; Mend sends no email. Whoever opens the link at `/join/<token>` creates an
account and joins with the link's role. Owners change roles, reset members' passwords, remove
people, take over projects a removed member left, and read the audit log; members read the roster.
A project is `private` (its creator only) or `shared` (the organization), and a project someone
cannot see answers as a missing one does.

## Sub-features

- `members-web` lists members in Settings → Members, one row each with email, role and join day.
- `members-cli` prints the roster with `mend members`, the caller's row marked `▸`.
- `invite-web` creates a one-time link from Settings → Invitations, optionally bound to an email.
- `invite-cli` prints a one-time link with `mend invite`, with `--role`, `--email` and `--days`.
- `invite-revoke` revokes an open invitation; spent ones are counted under `<n> spent`.
- `join` opens `/join/<token>`, creates an account and joins with the link's role.
- `join-refused` shows why a link cannot be used: not an invitation, spent, or the account already
  belongs to an organization.
- `role-change` makes a member an owner or an owner a member; the last owner is refused.
- `password-reset` prints a one-time reset link for a member (owners only).
- `member-removal` removes a member: sessions checkpointed then stopped, devices signed out, their
  open browser sent to `/login?reason=access`.
- `take-over` makes an owner the creator of a project whose creator was removed.
- `visibility` makes a project `private` or `shared` from its Setup page (owners only).
- `who-sees-what` hides a private project from everyone but its creator, in every listing.
- `audit-log` lists organization events newest first, with `Load earlier`.

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`. The panels `Members`, `Invitations`
  (owners), `Folders`, `Projects without a creator` (owners, only when there is one) and
  `Audit log` (owners) sit below `Devices`. Folders are mapped in
  [references-folders.md](./references-folders.md). The `Defaults · <org>` and
  `Workspace environment · <org>` panels near the top are mapped in
  [project-environment.md](./project-environment.md).
- Web: an invitation link `/join/<token>`, opened by the person it was handed to.
- Web: on a project's Setup tab (`/projects/<id>/setup`), the `Visibility` section at the top, for
  owners. The project header line ends with its visibility (`… · private` or `… · shared`).
- Web: the adopt panel's `only you` / `everyone in <org>` choice (mapped in
  [adopt-project.md](./adopt-project.md)).
- Web: `/login?reason=access`, where a removed member's open browser lands.
- CLI: `mend members`; `mend invite [--role member|owner] [--email <address>] [--days <n>]`;
  `mend adopt … --private|--shared`.
- Desktop, mobile, VS Code, TUI and Slack offer no organization controls.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` in `MEND_TENANCY=single` (the default). The browser and the `mend` CLI
  are signed in as the instance's first account, written `<owner>`: the organization's owner and
  the instance's operator. `mend members` prints `<org> · 1 member`.
- A second CLI identity for the invited account, written `<member>`, uses its own config directory:
  `mkdir -p /tmp/verify-member/mend`, then prefix its commands with
  `XDG_CONFIG_HOME=/tmp/verify-member`. Its browser is a second Playwright context (`memberPage`).
- `<project>` is adopted by `<owner>` as `private`; `<project>-shared` is adopted by `<owner>` with
  `mend adopt <repo-url> --name <project>-shared --shared`.

- **Refuse a bad role offline.** Run `mend invite --role admin`. Exit code `1`, stderr
  `mend: --role takes "member" or "owner", not "admin"`.
- **Invite from the CLI.** Run `mend invite --email verify-member@example.invalid --days 3`. Stdout
  line 1 is `<web>/join/<token>`, line 2 is
  `works once · member · for verify-member@example.invalid · expires <YYYY-MM-DD>`. Exit code `0`.
- **Invitations panel.** Go to `<web>/settings`. The heading `Invitations` is visible
  (`page.getByRole("heading", { name: "Invitations" })`) and a row reads
  `verify-member@example.invalid` with `member · created <day> · expires <day>` and a `Revoke`
  button.
- **Invite from the web, then revoke.** Run
  `await page.getByRole("textbox", { name: "Bind the link to an email (optional)" }).fill("revoke-me@example.invalid")`,
  `await page.getByRole("group", { name: "Role" }).getByRole("button", { name: "member" }).click()`,
  then `await page.getByRole("button", { name: "New link" }).click()`. The button reads
  `Creating…`, then a box says `Copy it now. The link is not shown again. It works once and expires <day>.`
  with the link and the buttons `Copy` and `Done`. Choose `Done`. Revoke the `revoke-me` row's
  `Revoke` (see Gotchas). The row leaves the open list and a summary `1 spent` appears.
- **Open a link that is not one.** Run `await memberPage.goto("<web>/join/not-a-token")`. The
  heading `This link is not an invitation` is visible.
- **Join.** Run `await memberPage.goto("<web>/join/<token>")` with the CLI's link. The heading is
  `<org>` and the line under it reads `as member · expires <day>`. Fill
  `memberPage.getByRole("textbox", { name: "Name" })` with `<member>`,
  `memberPage.getByRole("textbox", { name: "Email" })` with `verify-member@example.invalid`,
  `memberPage.getByLabel("Password", { exact: true })` and `memberPage.getByLabel("Password, again")`
  with one new password, then run
  `await memberPage.getByRole("button", { name: "Create account and join" }).click()`. The button
  reads `One moment…`, then the page lands on `/welcome`.
- **The link is spent.** Run `await memberPage.goto("<web>/join/<token>")` again from a fresh,
  signed-out context. The page reads
  `This invitation was already used. Ask an owner for a new link.`
- **Roster, both views.** Run `mend members`. Line 1 is `<org> · 2 members`; the `<owner>` row
  starts with `▸` and reads `owner`, the `<member>` row reads `member  joined <YYYY-MM-DD>`. Reload
  `<web>/settings`: the `Members` panel shows both, `<owner>` marked `you`.
- **Member CLI.** Sign `<member>` in on its own config directory (see
  [sign-in.md](./sign-in.md)), then run `XDG_CONFIG_HOME=/tmp/verify-member mend members`. The
  `▸` row is `<member>`. Run `XDG_CONFIG_HOME=/tmp/verify-member mend invite`. Exit code `1`,
  stderr `mend: only an owner can invite; mend members shows who`.
- **Who sees what.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend projects`. `<project>-shared`
  is listed and `<project>` is not. On `memberPage`, go to `<web>/projects`: a link whose name
  starts with `<project>-shared` is listed, and
  `memberPage.getByRole("link", { name: new RegExp("^<project>(?!-shared)") })` has count `0`. A member's Settings shows
  `Members` without `Make owner`, `Remove…` or the `Invitations` panel.
- **Visibility.** As `<owner>`, open `<web>/projects/<id>/setup` for `<project>`. Run
  `await page.getByRole("group", { name: "Visibility" }).getByRole("button", { name: "shared" }).click()`.
  The `shared` button reports `aria-pressed="true"` and the project header line ends `· shared`.
  `XDG_CONFIG_HOME=/tmp/verify-member mend projects` now lists `<project>`. Set it back to
  `private`.
- **Last owner.** In `Members`, run `await page.getByRole("button", { name: "Make member" }).click()`
  on `<owner>`'s row (the only one with that button). An alert reads
  `An organization needs an owner. Make someone else an owner before this one steps down.`
- **Role change.** Run `await page.getByRole("button", { name: "Make owner" }).click()`. The
  `<member>` row reads `… · owner · joined <day>`. Run the same row's `Make member` to restore it
  (now two buttons share that name; scope to the row as in Gotchas).
- **Password reset link.** Run `await page.getByRole("button", { name: "Reset password" }).click()`.
  A line reads `A password reset link for <member>. Setting a password with it signs them out everywhere.`
  above a one-time link to `/reset/<token>`. The reset page itself is mapped in
  [sign-in.md](./sign-in.md). Choose `Done`.
- **Leave a private project behind.** As `<member>`, adopt one:
  `XDG_CONFIG_HOME=/tmp/verify-member mend adopt <repo-url> --name <project>-left --auth ambient`.
  Stdout ends `  visible to only you`.
- **Remove the member.** Keep `memberPage` open on `<web>/`. As `<owner>`, run
  `await page.getByRole("button", { name: "Remove…" }).click()`. A group named `Remove <member>?`
  lists the three removal facts. Run
  `await page.getByRole("group", { name: "Remove <member>?" }).getByRole("button", { name: "Remove <member>" }).click()`.
  The button reads `Removing…`, then the row is gone. `memberPage` lands on `/login?reason=access`
  with a status (`memberPage.getByRole("status")`) reading
  `This account no longer belongs to an organization on this Mend. Its sessions are being stopped; their work so far is kept.`
- **Removed CLI.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend projects`. It is refused (the
  removal revokes every way the account signs in); expect exit code `1` with
  `mend: unauthorized at <web> — the saved token was rejected; run: mend login`.
- **Take over.** Reload `<web>/settings`. The heading `Projects without a creator` is visible, with a
  row `<project>-left` reading `private · adopted <day>`. Run
  `await page.getByRole("button", { name: "Take over…" }).click()`, then
  `await page.getByRole("button", { name: "Take over <project>-left" }).click()`. The panel
  disappears and `mend projects` lists `<project>-left`.
- **Audit log.** The `Audit log` panel lists, newest first, lines such as
  `<owner> took over project <id>`, `<owner> removed <member>`,
  `<owner> issued a password reset link for <member>`, `<owner> made <member> an owner`,
  `<owner> made project <id> shared`, `<member> joined as member`,
  `<owner> revoked an invitation link` and `<owner> created an invitation link for member`.
- **Proof.** Capture `/settings` after the invitation, after the join and after the removal
  (`await page.locator("body").ariaSnapshot()` and a screenshot with the `Members` heading
  visible), `memberPage` at `/join/<token>`, `/welcome` and `/login?reason=access`, and the
  transcripts of `mend invite`, both `mend members`, both `mend projects` and the refused member
  commands.

## Gotchas

- The Settings panels are `<section>` elements with an `h2` and no `aria-labelledby`
  (`apps/web/src/components/organization-settings.tsx:75`), so they are not regions. Scope to one
  with `page.locator("section").filter({ has: page.getByRole("heading", { name: "Members" }) })`.
  That is a finding: the sections need a label.
- Member row buttons carry no member name: `Make owner`, `Make member`, `Reset password`, `Remove…`
  and `Leave…` (`organization-settings.tsx:262-282`). They are unique only in a two-person
  organization. With more members, scope by the row's text:
  `page.locator("div").filter({ hasText: "verify-member@example.invalid" }).getByRole("button", { name: "Remove…" })`.
  That is a finding.
- `Revoke` on each open invitation carries no email or role (`organization-settings.tsx:458`). Scope
  by the row's text as above. That is a finding.
- `Take over…` carries no project name (`organization-settings.tsx:749`); its confirmation
  `Take over <name>` does.
- The minted link is a plain `<code>` element with no label (`organization-settings.tsx:357`). Read
  it with `page.getByText(/\/join\//)`. `Copy` writes to the clipboard, which a headless context may
  refuse; read the text instead.
- The two `Show password` toggles on `/join/<token>` share one name
  (`apps/web/src/components/auth-fields.tsx:84`) and toggle both fields together. The password
  inputs are not textboxes; use `getByLabel`.
- The audit log is a plain `<ol>` with no name (`organization-settings.tsx:816`). Assert entries with
  `page.getByRole("listitem").filter({ hasText: "…" })`. Project and session entries name the id,
  not the project's name.
- `--days` above 30 is cut to 30 without a message; below 1 is refused. The web link always expires
  after seven days.
- Settings pages re-read on their own when membership, roles or invitations change. Wait for the
  expected text; no reload is needed, and never wait for `networkidle`.
- A signed-in account opening an invitation for its own organization reads
  `You are already a member of <org>.` with `Open Mend`; one from another organization reads
  `This account belongs to …` with `Sign out`. Open join links in a signed-out context.
- `XDG_CONFIG_HOME` pointing at a directory with no `mend` folder falls back to a legacy `~/.mend`
  when that exists, so the second identity would share the first's token. Create
  `/tmp/verify-member/mend` first.
- The ADR's `multi` interface names the organization in the shell header; the web shell has no
  organization name (`apps/web/src/components/shell.tsx`). `multi` refuses to start until its gate
  passes, so this is not reachable today; it is a product gap for when it is.
- Owners reset only members' passwords: on an owner's row there is no `Reset password`, and owners
  and the operator are reset by the operator ([operator.md](./operator.md)).
