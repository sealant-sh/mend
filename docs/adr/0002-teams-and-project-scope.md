# Teams and project scope: membership decides what an account can see

Status: accepted 2026-09-12. Mend only; Sealant has no counterpart (`docs/SEALANT-IDENTITY.md`
already decided that sharing is a Mend concern and platform ownership stays per user).

## Context

A Mend instance has had accounts since the first-run registration landed, and per-user identity
(Sealant principal, git access, Mend key, dotfiles, skills) since 2026-08-22. Projects never got an
owner: `projects` carries no user column, `ProjectsRepo.list` has no predicate, and every
project-scoped route resolves its row by id alone. The event stream broadcasts every pointer to
every authenticated subscriber, and `/api/tty` admits any signed-in account to any session's
terminal. The only ownership checks are the Service tunnel (session owner only), user-scoped skills,
and the hot-pool claim. `docs/DOCUMENTATION-PLAN.md` records the consequence as the current security
posture: every signed-in account must be trusted with instance-wide workbench data.

That posture was fine for one developer behind a perimeter. It stops being fine the moment two
people share an instance and one of them adopts a repository the other should not see, or the moment
a team wants a new colleague to land in the right repositories without being handed everything on
the machine.

## Decision

**A team is a named group of accounts on one instance. Every project has exactly one scope, and
scope is what an account's access is checked against.**

- `team (id, name, created_by)`, `team_member (team_id, user_id, role ∈ owner | member)`,
  `team_invite (id, team_id, token_hash, role, email?, expires_at, accepted_by?, revoked_at?)`.
  Names are unique per instance. A team must keep at least one owner.
- `projects.team_id` and `projects.owner_user_id` (both nullable) encode the scope:
  - **team** — `team_id` set. Visible to the team's members.
  - **personal** — `owner_user_id` set, no team. Visible to that account only.
  - **instance** — both null. Visible to every account on the machine. This is what every project is
    today, so the migration leaves multi-account instances exactly as they are; on an instance with
    a single account every existing project becomes that account's personal project.
- **Visibility is the working permission.** An account that can see a project can do everything in
  it: adopt-time settings, environment, sessions, worktrees, review, terminals, Service tunnels. A
  collaborator attaching to a colleague's session still acts through the session owner's Sealant
  user (the workspace carries the owner's connected accounts), which the platform principal rule of
  2026-08-22 already provides.
- **Management is narrower.** Removing a project or changing its scope requires: the owner for a
  personal project; a team owner for a team project; any account for an instance project (today's
  rule, unchanged). Team owners rename the team, add and remove members, change roles, mint and
  revoke invites, and delete the team; a team cannot be deleted while a project is scoped to it.
  Members may leave.
- **Joining.** An owner adds an existing account by email, or mints a single-use invite link
  (`/join/<token>`, default seven days, optionally bound to one email). Only the token's sha256 is
  stored; the link is shown once. Registration stays open, so an invitee without an account
  registers and lands in the team on the same link.
- **Enforcement lives in one place.** A `ProjectAccess` service resolves a project, session,
  worktree, or change for the current account and fails as `NotFound` when the account cannot see it
  — the existing idiom (someone else's row is 404, never 403). Every project-scoped route asks it
  before touching the row. List routes filter by the same rule. The SSE endpoint filters pointer
  events per subscriber: project-scoped events reach members only, `user` events reach their own
  account, and `team` events reach the team's members; membership is re-read when a team or project
  pointer arrives. `/api/tty` and `/api/service-tunnel` apply the same visibility check.
- **Per-user things stay per-user.** Sealant accounts, the Mend key, git access mode, dotfiles, the
  user skill library, paired devices. Instance settings stay instance-wide.

## Considered options

- **Personal team per account, every project in a team.** One rule for everything, but it
  manufactures a team the user never asked for and needs a migration that invents teams on existing
  installs. Rejected; the nullable pair carries the same information without ghosts.
- **Per-project member lists instead of teams.** Sharing five repositories with the same four people
  means twenty rows to keep in step. Teams are the unit people already think in. Rejected as the
  primary model; a project can still be moved between scopes.
- **Hiding legacy instance projects behind an "assign me" step.** Would make an upgrade remove
  access. Rejected: no upgrade may hide a project from an account that could see it before.
- **Role gating on working actions (member read-only).** Adds a third role and a matrix nobody asked
  for. Rejected until a real need appears; the plan lists team governance as a non-goal.
- **Multi-use join links.** Convenient, but a leaked link is a standing door. Single-use links with
  an expiry match the pairing-code discipline already in the product.

## Consequences

- New accounts on a multi-account instance see instance-scoped projects and nothing else until
  someone adds them to a team or shares a personal project by moving it into one.
- The static dev token and device tokens authenticate as one account and inherit that account's
  view; the CLI's project list and `mend adopt` operate within it. `mend adopt` gains `--team`.
- The mobile, desktop, and VS Code clients consume the filtered lists unchanged; they see the new
  `teamId` / `ownerUserId` fields on a project and may ignore them.
- Removing an account cascades its memberships; its personal projects keep their store directory and
  become instance projects (owner set null) rather than vanishing.
- Open: team-scoped hot-pool warming (skeletons are still claimed only by their owner's sessions); a
  team-scoped skill library; an audit line on who changed a project's scope.
