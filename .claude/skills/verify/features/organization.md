# Organization, members and project visibility

An organization is the tenant: it owns its members, projects, folders, references and audit log. An
account belongs to one or more organizations, with a role in each, and each sign-in (a browser, the
CLI, a paired device) acts in one of them at a time. Registration closes after the first account, so
everyone else joins through a single-use invitation link that an owner prints with `mend invite` or
creates in Settings → Invitations; Mend sends no email. Whoever opens the link at `/join#<token>`
joins with the link's role: someone signed out creates an account, someone signed in joins with the
account they have. In `MEND_TENANCY=multi` the operator can also add an existing account to another
organization with `mend operator org add-member`. Owners change roles, reset members' passwords,
remove people, take over projects a removed member left, and read the audit log; members read the
roster. A project is `private` (its creator only) or `shared` (the organization), and a project
someone cannot see answers as a missing one does.

## Sub-features

- `members-web` lists members in Settings → Members, one row each with email, role and join day.
- `members-cli` prints the roster with `mend members`, the caller's row marked `▸`.
- `invite-web` creates a one-time link from Settings → Invitations, optionally bound to an email.
- `invite-cli` prints a one-time link with `mend invite`, with `--role`, `--email` and `--days`.
- `invite-revoke` revokes an open invitation; spent ones are counted under `<n> spent`.
- `join` opens `/join#<token>`, creates an account and joins with the link's role.
- `join-signed-in` opens `/join#<token>` while signed in as an account of another organization: it
  joins with that account and moves the browser's sign-in to the new organization.
- `join-refused` shows why a link cannot be used: not an invitation, spent, bound to another email,
  or the account is already a member of that organization.
- `role-change` makes a member an owner or an owner a member; the last owner is refused.
- `password-reset` prints a one-time reset link for a member (owners only).
- `member-removal` removes a member: sessions checkpointed then stopped, devices signed out, their
  open browser sent to `/login?reason=access`. For an account that still belongs to another
  organization only that membership goes: its sign-ins stay and its browser reloads at `/`.
- `org-cli` prints the CLI sign-in's organization and every membership with `mend org`, the active
  one marked `▸`.
- `org-switch-cli` moves the CLI's sign-in with `mend org switch <name|id>`; the web stays put.
- `org-switch-web` moves the browser's sign-in from the organization menu in the shell header and
  opens Now (`/`) in the chosen organization.
- `org-per-sign-in` keeps the web and the CLI of one account in different organizations at once.
- `org-isolation` answers 404 for another organization's project by id, even to a member of both.
- `org-leave` leaves an organization with `mend org leave <name|id>` or from Settings; refused for
  the last owner and for the account's only organization.
- `operator-add-member` adds an existing account to another organization with
  `mend operator org add-member <org> <email> [--role member|owner]` (`multi` only).
- `take-over` makes an owner the creator of a project whose creator was removed.
- `visibility` makes a project `private` or `shared` from its Setup page (owners only).
- `who-sees-what` hides a private project from everyone but its creator, in every listing.
- `audit-log` lists organization events newest first, with `Load earlier`.

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`. The panels `Members`, `Invitations`
  (owners), `Folders`, `Projects without a creator` (owners, only when there is one) and `Audit log`
  (owners) sit below `Devices`. Folders are mapped in
  [references-folders.md](./references-folders.md). The `Defaults · <org>` and
  `Workspace environment · <org>` panels near the top are mapped in
  [project-environment.md](./project-environment.md).
- Web: an invitation link `/join#<token>`, opened by the person it was handed to. A link from an
  older Mend, `/join/<token>`, opens the same page and the address bar then reads `/join#<token>`.
- Web: on a project's Setup tab (`/projects/<id>/setup`), the `Visibility` section at the top, for
  owners. The project header line ends with its visibility (`… · private` or `… · shared`).
- Web: the adopt panel's `only you` / `everyone in <org>` choice (mapped in
  [adopt-project.md](./adopt-project.md)).
- Web: `/login?reason=access`, where a removed member's open browser lands.
- CLI: `mend members`; `mend invite [--role member|owner] [--email <address>] [--days <n>]`;
  `mend adopt … --private|--shared`.
- CLI: `mend org`; `mend org switch <name|id>`; `mend org leave <name|id> [--yes]`;
  `mend operator org add-member <org> <email> [--role member|owner]`.
- Web, `multi` with more than one membership: the shell header names the active organization and
  opens a menu of the account's organizations with the role in each (apps/web shell). Settings →
  Organization offers leaving it when that is allowed.
- Desktop, mobile, VS Code, TUI and Slack offer no organization controls. They act in the
  organization their own sign-in has.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` in `MEND_TENANCY=single` (the default). The browser and the `mend` CLI
  are signed in as the instance's first account, written `<owner>`: the organization's owner and the
  instance's operator. `mend members` prints `<org> · 1 member`.
- A second CLI identity for the invited account, written `<member>`, uses its own config directory:
  `mkdir -p /tmp/verify-member/mend`, then prefix its commands with
  `XDG_CONFIG_HOME=/tmp/verify-member`. `MEND_TOKEN` and `MEND_URL` must be unset in the shell that
  runs either identity: the CLI reads them before its config file (`apps/cli/src/main.ts:327-331`),
  so an inherited `MEND_TOKEN` makes both identities the same account. Its browser is a second
  Playwright context (`memberPage`).
- `<project>` is adopted by `<owner>` as `private`; `<project>-shared` is adopted by `<owner>` with
  `mend adopt <repo-url> --name <project>-shared --shared`.

- **Refuse a bad role offline.** Run `mend invite --role admin`. Exit code `1`, stderr
  `mend: --role takes "member" or "owner", not "admin"`.
- **Invite from the CLI.** Run `mend invite --email verify-member@example.invalid --days 3`. Stdout
  line 1 is `<web>/join#<token>`, line 2 is
  `works once · member · for verify-member@example.invalid · expires <YYYY-MM-DD>`. Exit code `0`.
- **Invitations panel.** Go to `<web>/settings`. The heading `Invitations` is visible
  (`page.getByRole("heading", { name: "Invitations" })`) and a row reads
  `verify-member@example.invalid` with `member · created <day> · expires <day>` and a `Revoke`
  button.
- **Invite from the web, then revoke.** Run
  `await page.getByRole("textbox", { name: "Bind the link to an email (optional)" }).fill("revoke-me@example.invalid")`,
  `await page.getByRole("group", { name: "Role" }).getByRole("button", { name: "member" }).click()`,
  then `await page.getByRole("button", { name: "New link" }).click()`. The button reads `Creating…`,
  then a box says `Copy it now. The link is not shown again. It works once and expires <day>.` with
  the link and the buttons `Copy` and `Done`. Choose `Done`. Run
  `await page.locator("#invitations > div:last-child > div").filter({ hasText: "revoke-me@example.invalid" }).getByRole("button", { name: "Revoke" }).click()`
  (a CSS scope; see Gotchas). The row leaves the open list and a summary `1 spent` appears.
- **Open a link that is not one.** Run `await memberPage.goto("<web>/join#not-a-token")`. The
  heading `This link is not an invitation` is visible.
- **Join.** Run `await memberPage.goto("<web>/join#<token>")` with the CLI's link. The heading is
  `<org>` and the line under it reads `as member · expires <day>`. Fill
  `memberPage.getByRole("textbox", { name: "Name" })` with `<member>`,
  `memberPage.getByRole("textbox", { name: "Email" })` with `verify-member@example.invalid`,
  `memberPage.getByLabel("Password", { exact: true })` and
  `memberPage.getByLabel("Password, again")` with one new password, then run
  `await memberPage.getByRole("button", { name: "Create account and join" }).click()`. The button
  reads `One moment…`, then the page lands on `/welcome`.
- **The link is spent.** Run `await memberPage.goto("<web>/join#<token>")` again from a fresh,
  signed-out context. The page reads
  `This invitation was already used. Ask an owner for a new link.`
- **Roster, both views.** Run `mend members`. Line 1 is `<org> · 2 members`; the `<owner>` row
  starts with `▸` and reads `owner`, the `<member>` row reads `member  joined <YYYY-MM-DD>`. Reload
  `<web>/settings`: the `Members` panel shows both, `<owner>` marked `you`.
- **Member CLI.** Sign `<member>` in on its own config directory (see [sign-in.md](./sign-in.md)),
  then run `XDG_CONFIG_HOME=/tmp/verify-member mend members`. The `▸` row is `<member>`. Run
  `XDG_CONFIG_HOME=/tmp/verify-member mend invite`. Exit code `1`, stderr
  `mend: only an owner can invite; mend members shows who`.
- **Who sees what.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend projects`. `<project>-shared` is
  listed and `<project>` is not. On `memberPage`, go to `<web>/projects`: in the directory a row
  link whose name starts with `<project>-shared` and a space is listed
  (`memberPage.getByRole("main").getByRole("link", { name: new RegExp("^<project>-shared ") })`),
  and `memberPage.getByRole("main").getByRole("link", { name: new RegExp("^<project> ") })` has
  count `0`. Scope both to `main`: at 1024 px and wider the sidebar repeats every project the member
  can see as a link named exactly by its name. A member's Settings shows `Members` without
  `Make owner`, `Remove…` or the `Invitations` panel.
- **Visibility.** As `<owner>`, open `<web>/projects/<id>/setup` for `<project>`. Run
  `await page.getByRole("group", { name: "Visibility" }).getByRole("button", { name: "shared" }).click()`.
  The `shared` button reports `aria-pressed="true"` and the project header line ends `· shared`.
  `XDG_CONFIG_HOME=/tmp/verify-member mend projects` now lists `<project>`. Set it back to
  `private`.
- **Last owner.** In `Members`, run
  `await page.getByRole("button", { name: "Make member" }).click()` on `<owner>`'s row (the only one
  with that button). An alert reads
  `An organization needs an owner. Make someone else an owner before this one steps down.`
- **Role change.** Run `await page.getByRole("button", { name: "Make owner" }).click()`. The
  `<member>` row reads `… · owner · joined <day>`. Restore it: two buttons are now named
  `Make member`, so run
  `await page.locator("#members > div:last-child > div").filter({ hasText: "verify-member@example.invalid" }).getByRole("button", { name: "Make member" }).click()`.
- **Password reset link.** Run `await page.getByRole("button", { name: "Reset password" }).click()`.
  A line reads
  `A password reset link for <member>. Setting a password with it signs them out everywhere.` above
  a one-time link to `/reset#<token>`. The reset page itself is mapped in
  [sign-in.md](./sign-in.md). Choose `Done`.
- **Leave a private project behind.** As `<member>`, adopt one:
  `XDG_CONFIG_HOME=/tmp/verify-member mend adopt <repo-url> --name <project>-left`. Stdout contains
  the line `  visible to only you`.
- **Give the member a live session.** If `<member>` has `mend connect claude`, run
  `XDG_CONFIG_HOME=/tmp/verify-member mend claude "List the files and change nothing." --name verify-removed --project <project>-shared --detach`
  and note `<m8>`. `mend sessions --project <project>-shared` (as `<owner>`) lists it live. Without
  a provider, skip this step and report the session-stop effect of removal unreachable.
- **Remove the member.** Keep `memberPage` open on `<web>/`. As `<owner>`, run
  `await page.getByRole("button", { name: "Remove…" }).click()`. A group named `Remove <member>?`
  lists the three removal facts. Run
  `await page.getByRole("group", { name: "Remove <member>?" }).getByRole("button", { name: "Remove <member>" }).click()`.
  The button reads `Removing…`, then the row is gone. `memberPage` lands on `/login?reason=access`
  with a status (`memberPage.getByRole("status")`) reading
  `This account no longer belongs to an organization on this Mend. Its sessions are being stopped; their work so far is kept.`
- **Removed CLI.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend projects`. It is refused (the
  removal revokes every way the account signs in); expect exit code `1` with
  `mend: unauthorized at <web> — the saved token was rejected; run: mend login`. This wording is the
  CLI's for any rejected token; that a removed account's token is rejected comes from the removal
  code's comment, not from a traced request.
- **Their session stopped, work kept.** If the live-session step ran, run
  `mend sessions --project <project>-shared --all --json` as `<owner>`. The `verify-removed` session
  is no longer live, and its `reviewUrl` still opens the session page. Stopping is asynchronous
  (checkpoint, then stop); poll the listing rather than sleeping.
- **Take over.** Reload `<web>/settings`. The heading `Projects without a creator` is visible, with
  a row `<project>-left` reading `private · adopted <day>`. Run
  `await page.getByRole("button", { name: "Take over…" }).click()`, then
  `await page.getByRole("button", { name: "Take over <project>-left" }).click()`. The panel
  disappears and `mend projects` lists `<project>-left`.
- **Audit log.** The `Audit log` panel lists, newest first, lines such as
  `<owner> took over project <id>`, `<owner> removed <member>`,
  `<owner> issued a password reset link for <member>`, `<owner> made <member> an owner`,
  `<owner> made project <id> shared`, `<member> joined as member`,
  `<owner> revoked an invitation link` and `<owner> created an invitation link for member`.
- **Proof.** Capture `/settings` after the invitation, after the join and after the removal
  (`await page.locator("body").ariaSnapshot()` and a screenshot with the `Members` heading visible),
  `memberPage` at `/join#<token>`, `/welcome` and `/login?reason=access`, and the transcripts of
  `mend invite`, both `mend members`, both `mend projects` and the refused member commands.

## Driving organization switching with verify

Preconditions:

- Mend runs with `MEND_TENANCY=multi`. It refuses to start until every item of the multi mode gate
  is satisfied: run `mend operator gate` on a single-tenancy start first and set what each open item
  names (`MEND_SOURCE_POLICY=tenant`, `MEND_CAPTURE_REQUIRE_SIZES=true` with an `s3://`
  `MEND_BLOB_STORE`, loopback-only `MEND_SERVICE_HOSTS`). If the run cannot satisfy the gate, report
  this section unreachable; do not weaken the gate.
- `<owner>` is the operator and the owner of `<org>` (`Acme` below). Create the second one:
  `mend operator org create Globex`, then
  `mend operator org invite-owner Globex --email <owner-email>`. `mend operator org list` lists
  both.
- `<member>` is signed in on its own config directory as in the single-tenancy preconditions above,
  and is a member of `Acme` only. `<project>-shared` is a shared project in `Acme`.
- Note `<acme-id>` and `<globex-id>` from `mend org` after each switch, or from
  `curl -s -H "authorization: Bearer <token>" <web>/api/account/organizations`.

- **Join a second organization while signed in.** Open the `invite-owner` link from the browser
  signed in as `<owner>`. The join page names `Globex` and the signed-in email and offers to join
  with that account; it does not ask for a name or password. Joining lands on Now (`/`) in `Globex`,
  and the shell header names `Globex`. No second account exists: `mend operator org list` reads
  `Globex  1 member · 1 owner`.
- **The CLI did not move.** Run `mend org`. Line 1 is `Acme · owner · 2 organizations`; the `▸` row
  is `Acme`, the other row reads `Globex  owner   joined <YYYY-MM-DD>`. Exit code `0`.
- **Web and CLI in different organizations at once.** With the browser in `Globex` and the CLI in
  `Acme`, `mend projects` lists `<project>-shared` and the browser's `/projects` does not.
- **Switch the CLI.** Run `mend org switch GLOBEX` (any case). Stdout is
  `✓ switched to Globex · owner`, then
  `this sign-in only · the web and other devices stay where they are`. `mend org` now marks
  `Globex`. `mend projects` no longer lists `<project>-shared`. Run `mend org switch Initech`: exit
  code `1`, stderr
  `mend: you are not a member of an organization named "Initech" · mend org lists yours`.
- **Isolation by id.** With the CLI in `Globex`, request `<project>-shared` by its id:
  `curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer <token>" <web>/api/projects/<id>`
  prints `404`, the same as a made-up id. Switch back with `mend org switch acme` and the same
  request prints `200`.
- **Switch the web.** In the browser, open the organization menu in the shell header and choose
  `Acme`. The page lands on `/` in `Acme`; the CLI's `mend org` still marks the organization it
  switched to.
- **Operator adds an existing account.** Run
  `mend operator org add-member Globex verify-member@example.invalid`. Stdout is
  `✓ verify-member@example.invalid is a member of Globex`, then
  `they switch to it with mend org switch Globex, or on the web`. Then
  `XDG_CONFIG_HOME=/tmp/verify-member mend org` lists both, `▸` still on `Acme`. Repeat the command:
  exit code `1`, stderr `mend: That account already belongs to Globex.` With an unknown email:
  `mend: No active account in an organization has that email. Invite them instead.` With
  `--role admin`: `mend: --role takes "member" or "owner", not "admin"`, and nothing is sent.
- **Leave.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend org leave globex`. Without a terminal it
  refuses: `mend: non-interactive · pass --yes to leave Globex`. With `--yes`:
  `✓ left Globex · this sign-in now acts in Acme`. The member's other sign-ins still work
  (`mend projects` exit `0`). `Globex`'s audit log reads `<member> left`.
- **Leave refused.** As `<owner>`, the only owner of `Globex`, run `mend org leave globex --yes`:
  `mend: An organization needs an owner. Make someone else an owner before you leave.` As `<member>`
  with only `Acme` left, `mend org leave acme --yes`:
  `mend: This is your only organization. Ask one of its owners to remove you instead.`
- **Single tenancy.** On a `MEND_TENANCY=single` run, `mend org` prints one line,
  `<org> · owner · joined <YYYY-MM-DD>`, the web header has no organization menu, and
  `mend operator org add-member <org> <email>` is refused with
  `mend: This Mend runs one organization (MEND_TENANCY=single). Invite people with a link instead.`
- **Proof.** Capture the join page signed in, the shell header menu, `/` after each web switch, and
  the transcripts of every `mend org`, `mend org switch`, `mend org leave`, `curl` status and
  `mend operator org add-member` above.

## Gotchas

- The Settings panels are `<section>` elements with an `h2` and no `aria-labelledby`
  (`apps/web/src/components/organization-settings.tsx:75`), so they are not regions. Scope to one
  with `page.locator("section").filter({ has: page.getByRole("heading", { name: "Members" }) })`.
  That is a finding: the sections need a label.
- Member row buttons carry no member name: `Make owner`, `Make member`, `Reset password`, `Remove…`
  and `Leave…` (`organization-settings.tsx:262-282`). They are unique only in a two-person
  organization. The rows have no role (plain `div`s inside the panel's body,
  `organization-settings.tsx:249`), so there is no ARIA scope. Scope with CSS to the panel body's
  direct children, filtered by email:
  `page.locator("#members > div:last-child > div").filter({ hasText: "<email>" })`. A plain
  `page.locator("div").filter({ hasText })` also matches the ancestor that holds every row and fails
  strict mode. That is a finding: the rows need a role and a name.
- `Revoke` on each open invitation carries no email or role (`organization-settings.tsx:458`), and
  the invitation rows have no role either (`organization-settings.tsx:448`). Scope with
  `page.locator("#invitations > div:last-child > div").filter({ hasText: "<email>" })`. That is a
  finding.
- `Take over…` carries no project name (`organization-settings.tsx:749`); its confirmation
  `Take over <name>` does.
- The minted link is a plain `<code>` element with no label (`organization-settings.tsx:357`). Read
  it with `page.getByText(/\/join\//)`. `Copy` writes to the clipboard, which a headless context may
  refuse; read the text instead.
- The two `Show password` toggles on `/join#<token>` share one name
  (`apps/web/src/components/auth-fields.tsx:84`) and toggle both fields together. The password
  inputs are not textboxes; use `getByLabel`.
- The audit log is a plain `<ol>` with no name (`organization-settings.tsx:816`). Assert entries
  with `page.getByRole("listitem").filter({ hasText: "…" })`. Project and session entries name the
  id, not the project's name.
- `--days` above 30 is cut to 30 without a message; below 1 is refused. The web link always expires
  after seven days.
- Settings pages re-read on their own when membership, roles or invitations change. Wait for the
  expected text; no reload is needed, and never wait for `networkidle`.
- A signed-in account opening an invitation for its own organization reads
  `You are already a member of <org>.` with `Open Mend`. One from another organization joins with
  the signed-in account. Open a join link in a signed-out context when the step means to create an
  account.
- A switch ends the sign-in's event stream and closes its sockets. The CLI's sign-in is shared by
  every `mend` process on the machine, so `mend org switch` in one terminal drops a `mend attach` in
  another; reconnecting to a session of the old organization should then answer as a missing one
  (expected from the authorization rule, not yet driven). Tabs of one browser share a sign-in and so
  share one organization.
- A new sign-in (a fresh `mend login`, a newly paired device) starts in the organization the account
  switched to last.
- `XDG_CONFIG_HOME` pointing at a directory with no `mend` folder falls back to a legacy `~/.mend`
  when that exists, so the second identity would share the first's token. Create
  `/tmp/verify-member/mend` first.
- Owners reset only members' passwords: on an owner's row there is no `Reset password`, and owners
  and the operator are reset by the operator ([operator.md](./operator.md)).
