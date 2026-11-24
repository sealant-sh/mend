# Settings: one home per setting, and nothing inherits

Status: accepted 2026-11-16, for the new web app; not built. Amended 2026-11-24 for Access policies
(below). Yiannis decided it with the redesign plan ("Mend redesign: the plan, step by step", Linear
project "Web redesign"), and the Settings pages on the Doop canvas "Mend" (page "7 · Settings") are
drawn to it. The new app's settings routes build it, last in the rebuild's list of PRs (Linear
document "Mend web rebuild: the list of PRs"). Read against Mend `732269db61`. Changes
[ADR 0003](0003-organizations-and-tenancy.md) (what an organization's values mean for its projects)
and withdraws decision 2 of [ADR 0018](0018-api-key-logins-and-organization-keys.md) (organization
keys, never built).

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

## Amendment, 2026-11-24: Access policies

Workspace isolation (agent-home `docs/workspace-isolation-architecture.md`, §8.1; Linear SLNT-1314)
adds worktree Access policies, and needs two homes this ADR did not have. Both keep its rule: one
home per value, nothing inherits.

### A1. Organization → Access policies holds templates of rules

A new home, **Organization → Access policies**, changed by Owners. It holds reusable policy
templates: the built-in `Standard`, and templates owners create, such as `Restricted egress` or an
elevated policy for production work. A template holds rules only: allowed hosts, whether Executor
tools may be called (`allowExecutorTools`), the Git transport cap (A2). It never holds a secret
value; secrets stay in **Project → Variables and secrets**, so decision 2's removal of
organization-wide secrets stands.

A template is copied, never inherited, as the starting image is (decision 5). A new project gets a
copy of `Standard` as its own policy, under **Project → Workspace**. Assigning a template copies its
rules into the project; the project records which template and revision it came from only so a
revocation reaches it and the page can say a newer revision exists. Editing a template never changes
a project or a running worktree. A worktree keeps the rules it started with until someone applies
the newer ones to it, and a revocation always applies.

### A2. A policy caps Mend's Git signer

An Access policy may carry a `gitTransport` cap: `disabled`, `read-only` or `read-write` (the
default). It caps whether Mend's Git signer fetches and pushes for that worktree: `read-only` signs
fetches and archives, never a push; `disabled` signs nothing. It is not a second Git access mode.
The person's own Git access mode, under You (decision 1), still chooses how they sign, with the Mend
key or through the bridge. The cap covers Mend's signer only: a credential the person brings into
the workspace themselves does not pass through it.

### Where the rules are read

Mend's Git signer and its MCP dispatcher each read a session's worktree policy from one place
(`AccessPolicies` in `@mend/sessions`): the rules the worktree pinned when it was created, less
every revocation that reaches it. A worktree from before Access policies pinned nothing and reads
`Standard`: the signer signs fetches and pushes, and Executor tools may be called. Whatever the cap,
the signer pushes only to the project's own repository, by its canonical path, and refuses a push
for a project whose origin is missing or ambiguous; it fetches from any repository on the origin's
host, which submodules and other repositories of a session need. An operator who turns the origin
binding off on a machine they alone use (`MEND_GIT_TRANSPORT_BIND_ORIGIN=false`) lifts both
bindings, never the cap.

### A3. Secrets stay in one home, Direct or Brokered

A project secret is **Direct** (its value reaches the workspace's environment, as before) or
**Brokered** (the workspace holds a placeholder, and only its egress proxy puts the value in one
named header on requests to the secret's bind hosts). Both live in **Project → Variables and
secrets**; the project owns the binding, and no template names a project's secret. A Brokered secret
reaches a workspace only when the project's policy allows Brokered secrets, which makes the policy
elevated: assigning it takes an Organization Owner, and so does turning a Brokered secret back to
Direct. A launch never falls back to putting a Brokered secret's value in the environment.

### A4. Revocations are kept, and win

An Organization Owner can revoke a host, a secret or everything, for one template's worktrees or for
all of them. The revocation is stored first, then sent to every running workspace it reaches, and it
holds over every pin, every "Apply updated policy" and every later launch.
