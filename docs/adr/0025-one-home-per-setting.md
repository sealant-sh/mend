# Settings: one home per setting, and nothing inherits

Status: accepted 2026-11-16, for the new web app; not built. Yiannis decided it with the redesign
plan ("Mend redesign: the plan, step by step", Linear project "Web redesign"), and the Settings
pages on the Doop canvas "Mend" (page "7 · Settings") are drawn to it. The new app's settings routes
build it, last in the rebuild's list of PRs (Linear document "Mend web rebuild: the list of PRs").
Read against Mend `732269db61`. Changes [ADR 0003](0003-organizations-and-tenancy.md) (what an
organization's values mean for its projects) and withdraws decision 2 of
[ADR 0018](0018-api-key-logins-and-organization-keys.md) (organization keys, never built).

## Context

Most settings today resolve through a cascade. A person's automation switches (description and tour,
suggested fixes, automatic naming, landing when a turn completes, background sessions) each take
Inherit, On or Off, and `/me/automation` answers the person's value, else the organization's, else
the instance's. A project can override them again. A new project's workspace image follows the
organization's, else the instance's, until someone sets its own. Projects have switches to take or
refuse the person's dotfiles and skills ("Apply my dotfiles", "Use global skills"), their own Git
access mode, recipes saved in the database beside `.mend/mend.toml`, and a landing policy. The
operator has an Instance settings group of defaults under every organization.

That makes each value a question with three or four answers. A page shows "Inherit" and the person
has to open a "who sets their own value" side sheet to learn what their sessions will actually do.
An owner changing an organization default changes every member's sessions without any of them
touching their own page. Every setting is drawn and tested at every level it can be set.

## Decision

### 1. Every setting is stored in exactly one place

| Home                     | Holds                                                                                                                                                                                                                                                                                                                                                                       | Changed by              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **You** (account)        | Profile; sign-in, devices and access keys; agent logins; GitHub, the Git key, the Git author and the Git access mode; dotfiles, secret files, skills and MCP servers; notifications; **Your automation** (description and tour, suggested fixes, land when a turn completes, and whether settling a T3 Code thread stops its session); your own links to Slack and Executor | You, on every device    |
| **This device**          | Theme, text size, terminal font                                                                                                                                                                                                                                                                                                                                             | You, per browser or app |
| **Organization**         | Name; members, roles and invitations; the audit log; the starting image; session runtime; the Boat key; the Slack app with each channel's default project; the organization's Executor; folders and reference repositories                                                                                                                                                  | Owners                  |
| **Project**              | Name and visibility (private or shared); its workspace image, dependency install and ready workspaces; its own variables and secrets; its own skills; which folders and references it uses                                                                                                                                                                                  | Its creator or an owner |
| **Project, in the repo** | Setup, services, resources and preview, in `.mend/mend.toml`. Settings shows them read-only and says to edit the file                                                                                                                                                                                                                                                       | Anyone who can commit   |
| **You, in one project**  | Agent memory and the Doppler config, shown inside the project under "Only you"                                                                                                                                                                                                                                                                                              | You                     |
| **Server**               | Address and exposure, the runtimes offered, storage, limits, mirrors, and the list of organizations. Read-only in the app: changed with `mend server setup` or Helm                                                                                                                                                                                                         | The operator            |

A value's home is where it is changed and the only place it is read from. No level fills in a value
another level left unset.

### 2. Removed outright

These have no setting anywhere:

- "Name the session": sessions are always named.
- "Background sessions": `--foreground` on the CLI is enough.
- "Default shell profile".
- The default agent, model and effort. The composer remembers your last choice, on your account.
- The personal Boat key. The organization's Boat key is the only one, and the organization always
  pays.
- The project switches "Apply my dotfiles" and "Use global skills". Your dotfiles and skills always
  follow you.
- A project's own automation page and its landing policy.
- Organization automation, and organization-wide variables, secrets, skills and provider keys.
- Service recipes saved in the database. Services come only from `.mend/mend.toml`.
- The Instance settings group and every inherited default under it.
- The per-project Git access mode. It is yours, under You.

### 3. Where two things still meet

Two pairs still meet. Neither is an override, and the page where each shows says which wins:

- A project skill wins over one of yours with the same name.
- Your own Executor link is used before the organization's shared one (ADR 0022, decision 4).

### 4. The composer starts from your value, and the session keeps what was picked

"Land when a turn completes" sets where the composer starts. The person can change it for one
session, and the session records what was picked, so changing the setting later never changes a
session that already started.

### 5. The starting image is copied, not inherited

An organization's starting image is copied into each new project when the project is created. From
then on it is the project's own image. Changing the organization's starting image never touches an
existing project.

### 6. Every page says who it is for

Under each settings page's title, one muted line names the page's audience: "Only you", "Only this
browser", "Everyone in Northwind", "Everyone who can open checkout-api", "Operators of this server".
The audience line follows from the home, so a page never mixes two.

### 7. What the server loses

- The Inherit value. Every switch in `/me/automation` (`PersonAutomationView`'s `inherited` and
  `inheritedFrom`) and every project and organization value that can be null to follow a level above
  becomes a plain value.
- The instance's defaults under organizations (`OrganizationSettingsView.instance`, and `effective`
  for projects on inherit).
- The image cascade: a new project gets a copy of the organization's starting image at creation.
- The project switch `inheritUserSkills` and the dotfiles switch.
- The personal Boat key (`personBoatKeyGroup`).
- Organization keys (ADR 0018, decision 2). They were never built.
- The organization's automation, a project's automation and landing policy, project recipes saved in
  the database, and a project's own Git access mode.

The rebuild's list of PRs names one server ticket for each change a settings page needs, such as
Your automation without Inherit and copying the starting image.

### 8. Until the server changes land

- The server keeps resolving every value through its cascade, as it does today.
- The old web app (`apps/web-old`) keeps its Inherit controls and the "who sets their own value"
  view, and keeps writing the values the server reads. Its Settings pages are what people use until
  cut-over.
- A settings page in the new app shows a value only from its one home. A page whose value the server
  still resolves through a cascade lands with, or after, the server change that stores it in that
  home. It never shows an inherited value.
- The CLI, the API and Helm are unchanged until each server ticket changes them.

## Considered options

- **Keep inheritance and add a "who sets their own value" view** (the earlier canvas: the Inherit
  choice and Inherited setting components, and a side sheet listing whose value differs). Rejected:
  the view answers a question only the cascade creates, a person still can't tell from their own
  page what their sessions do, and an owner's change still reaches members' sessions without anyone
  seeing it on their page.

## Consequences

- Each value has one page, one audience and one writer, and a session's behaviour can be read off
  the person's and the project's own pages.
- Owners can no longer turn a behaviour on for every member at once. Each person sets their own.
- A project skill and a person's skill of the same name are the only case where two homes hold the
  same thing, and the project's wins.
- The words of the new Settings (Your automation, This device, Only you, the audience lines) appear
  only on the canvas and in this ADR until the new app ships them. The public glossary changes then.

## Open

- How each server change turns a stored Inherit (a null) into a plain value. Each server ticket
  decides it for its values.
