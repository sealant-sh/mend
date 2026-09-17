# Organizations and tenancy: one boundary for single-user, team and multi-tenant Mend

Status: accepted 2026-09-17. Settles the product decisions that
[team support findings](../reviews/team-support-findings.md) asked for before permissions are
implemented, and the Mend half of the account and authorization blockers in
[public exposure findings](../reviews/public-exposure-findings.md). Budgets (MEND-05, CORE-04) are
deliberately deferred; see "Multi mode gate". Teams inside an organization are out of scope.

## Context

On main, Mend is a single-operator machine that happens to accept several accounts. Registration is
open (`packages/auth/src/auth.ts`). Projects have no owner or scope column, and names and store
paths are unique across the instance (`packages/db/src/schema/workbench.ts`). Any signed-in account
can attach to another account's terminal, send turns to its sessions, or remove a project. The only
ownership check is the service tunnel's. "Operator" means the oldest account: `MEND_STATIC_TOKEN`,
hot-pool warming and legacy runs all act as it. Push devices, the SSH-agent signer, the host's `gh`
login, reference repositories, host mounts and machine settings belong to the whole instance.

The goal is a Mend that can be hosted for people who do not trust each other, while an install for
one person or one company stays as simple as today. A team branch (`yp/mend-team-bs`) has useful
parts: invitations, the last-owner lock, central `ProjectAccess`, and the team UI. It predates the
capture store, and its review found twelve blockers. It is ported in pieces, not merged.

## Decision

### Tenancy mode

`MEND_TENANCY=single|multi`, default `single`.

- `single`: one organization exists. The first account is both the operator and that organization's
  owner.
- `multi`: many organizations exist on one instance. They must not be able to see or affect each
  other.
- `single` to `multi` is allowed once the multi mode gate passes; the existing organization becomes
  the first of many. Switching from `multi` to `single` is refused at startup when more than one
  organization exists.

The same authorization model runs in both modes. `single` is not a bypass; it only fixes the
organization count at one and hides organization chrome.

### Multi mode gate

Starting with `MEND_TENANCY=multi` is refused until isolation is complete. Startup names every item
still missing. Required:

1. Authorization across organizations, proven by a route-level harness with two organizations and
   two users per organization, asserting both the refusal and that the refused call had **zero
   effects**. It covers HTTP, SSE, WebSocket (TTY, service tunnel) and job paths.
2. Per-user SSH-agent signer, push devices, notifications and GitHub identity (MEND-02, MEND-03,
   MEND-09).
3. Mend-managed folders in place of host paths for tenants (MEND-07, B3).
4. Local Git sources and private or loopback destinations refused for tenants (MEND-06, MEND-07).
5. Upload signatures bound to exact content length, with stored-size verification (MEND-04).
6. Raw service ports bound to loopback only.

Not required to open a private beta, and tracked as later work: per-organization and per-user
budgets (concurrent live sessions, captured bytes, hot pool size, inference spend, request rate,
open streams) and Core's per-principal limits and owner scoping (CORE-03, CORE-04). When budgets
land, hitting one refuses new work with a stated reason and never kills a running session.

Rejected: shipping `multi` with a warning banner (anyone can run an unhardened "multi-tenant"
instance by accident), and gating on all hardening including budgets (an invited beta tenant is
unlikely to exhaust resources on purpose, but missing isolation leaks code whatever their intent).

### Operator

The operator is an instance role, separate from organization ownership. It administers the machine:
organizations, instance limits, operator folders and host paths, machine settings, and recovery of
an organization with no owner. The operator has **no default read access to organization content**:
it is not a member of every organization and cannot open their projects, sessions or changes.
Recovery is an explicit action that is recorded in the audit log.

The operator works through the CLI (`mend operator …`), authenticated as an account holding the
role. A web admin page may come later. Keeping operator power out of the ordinary web app makes "no
default read access" easy to check.

Rejected: a superuser who sees everything (tenants would have to trust the operator with their
code), and letting organization owners administer the machine (there is no single owner in `multi`).

### Organizations, membership and enrollment

- The organization is the tenant. It owns its members, projects, folders, reference repositories,
  audit log and, later, budgets.
- An account belongs to **exactly one** organization in v1. The membership table is many-to-many
  with a unique constraint on the user, so allowing several organizations later is one migration.
  Until then, a user's dotfiles, skills, signer and provider logins never cross organizations inside
  one account. Consultants use one account per organization.
- Roles are `owner` and `member`.
  - Members adopt projects, start sessions and review in projects they can see, and edit settings on
    projects they created.
  - Owners also invite and remove people, change roles, make projects private or shared, delete any
    shared project, manage folders and references, and run recovery.
  - The last owner cannot be removed or demoted (the branch's per-organization advisory lock). An
    account that is deactivated outside that path triggers operator recovery, never an ownerless
    organization.
- Enrollment is by invitation only, in both modes. There is no self-serve registration.
  - `single`: the first account registers. After that, registration closes.
  - `multi`: the operator creates an organization and invites its first owner. That owner invites
    the rest.
  - Invitations are single-use links: a 32-byte random token hashed at rest, with an expiry and an
    optional email binding, revocable, and accepted under a row lock. An owner copies the link and
    shares it. Mend sends no email in v1.
- Password recovery: an owner issues a one-time reset link for a member, and the operator for any
  account in an organization. The token lives in Better Auth's verification storage for a day and is
  consumed by its reset endpoint, which also ends the account's sessions. Email delivery arrives
  with self-serve registration, if ever.

Rejected for v1: teams inside an organization (none of the blockers require them; one fewer level to
secure), per-project roles, an admin role between owner and member, and self-serve registration.

### Projects

- Every project belongs to exactly one organization and is either **private** (visible to its
  creator only) or **shared** (visible to every member). Private is a visibility setting, not a
  separate owner. There is no instance-wide scope and no personal project outside an organization.
  This removes by construction B6 (account deletion widening access) and B10 (anyone claiming an
  instance project).
- The creator picks the visibility when adopting. After that, only an owner changes it.
- Names are unique within an organization, not across the instance. The CLI resolves names inside
  the caller's organization; automation uses IDs.
- New project stores live at `store/<projectId>`. Existing projects keep their recorded `storePath`.
  Storage paths and object prefixes are never permission checks.
- An inaccessible project, session, worktree, change, process or capture answers exactly like a
  missing one (404), and authorization happens **before** any effect, platform call, lifecycle or
  protocol disclosure (B1, B8, B11). An adoption name conflict says the name is unavailable, without
  path or scope detail.

### Project links

- Links only point at projects in the same organization.
- The session owner must be able to see the target at every launch, pool claim and restore. If they
  cannot, the link is skipped and the session shows a visible notice.
- Only its creator can link to a private project.

### Sessions and shared control

A session always runs as its owner, the account that started it, using that account's provider
logins, Git access, dotfiles and Sealant principal. Anyone who can see the project can see the
session, review its change and draft review comments.

**Steering** means sending turns, answering approvals, interrupting, typing into its terminal, and
sending review comments back to it. By default, only the owner steers. An organization owner may
also stop any session.

The owner may turn on **shared control** for one session. While it is on:

- anyone who can see the project may steer it;
- the session shows "Runs as \<owner\>" to everyone else, because their actions spend the owner's
  credentials;
- every turn, approval, interrupt and terminal attach is recorded with the account that sent it;
- an organization owner may turn it off;
- it ends when the owner is removed.

Rejected: letting anyone with project access steer by default. That delegates someone else's
credentials and spend without their consent.

### Removing a member

1. New requests are refused immediately. Open WebSocket, SSE and terminal connections are closed. No
   new capture grants or presigned URLs are issued under their authority.
2. Their live sessions are checkpointed and flushed, then stopped through the normal lifecycle.
   Capture durability is never bypassed to clean up faster.
3. An access-change event tells their clients to invalidate caches and close panes.
4. Their private projects stay in the organization and stay invisible. An owner may take one over
   through a recovery action that is recorded in the audit log.
5. The account is **deactivated**, not deleted. Hard deletion needs a data retention policy
   (CORE-07) and is out of scope.

URLs and data already handed out cannot be recalled. Presigned URLs keep their residual lifetime,
which is measured rather than assumed.

### Resources that were instance-global

| Resource               | Decision                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host mounts            | Replaced by **folders**: Mend-managed directories owned by an organization and stored under it, created by owners and selected per project. Arbitrary host paths remain only for the operator in `single`.                                                                      |
| Reference repositories | Owned by the organization, managed by owners, refreshed with the requesting owner's Git access. Never the host's ambient identity.                                                                                                                                              |
| GitHub actions         | Git over SSH runs with the caller's own access (`user_git_access`). Calls to the GitHub API have no per-account credential yet: only the operator in `single` may use the host's `gh` login, and everyone else is told there is no identity. A per-account token is later work. |
| Push devices           | Belong to a user.                                                                                                                                                                                                                                                               |
| Notifications          | Go to the session owner, and in shared-control sessions also to the account that sent the latest turn.                                                                                                                                                                          |
| SSH-agent signer       | One per user; resolution never falls back to another user's signer.                                                                                                                                                                                                             |
| Raw service ports      | Loopback only in `multi`. Service access goes through the authenticated tunnel.                                                                                                                                                                                                 |
| Machine settings       | Operator only.                                                                                                                                                                                                                                                                  |

### Hot pools

Pool entries are keyed by organization, project, owner and a fingerprint of the launch inputs.
Warming runs as that owner, and authorization is checked before provisioning and again before a
claim. Entries are drained when access changes. Nothing warms as the first account any more, and a
credential-bearing workspace is never handed to another user. Pools warm only for owners who
recently ran a session in the project, so they do not multiply with the member count (B4): the four
most recent within a week, each warmed to the project's hot session count. A person's first session
is cold and starts warming for them. The setup page counts the viewer's own standbys.

### Audit log

Owners see their organization's events: membership, invitations, role and visibility changes, shared
control, recovery takeovers, folders and references. The operator's acts on an organization (naming
it, inviting or granting an owner, a password reset) are recorded in that organization's log, so its
owners see what the operator did; the operator reads no organization content. Stored in Postgres and
kept indefinitely in v1.

### Interface

- `single`: the organization is nearly invisible. Settings gains Members (invitations, roles,
  removal), Folders and References. Projects gain a private/shared control. There is no organization
  name in the shell.
- `multi`: the organization name appears in the shell header. There is no switcher, because an
  account has one organization.
- Controls an account's role does not allow are not shown, rather than shown and refused.

### Upgrade

Only the author's instances exist, so the upgrade takes the simplest path that widens nothing:
create one organization; every existing account joins it; the oldest account becomes operator and
owner; every existing project becomes shared; sessions with no owner are assigned to the oldest
account, matching today's fallback.

## Consequences

- The product language gains nouns: `organization`, `operator`, `owner`, `member`, `invitation`,
  private and shared `project` visibility, `shared control` and `folder`. `AGENTS.md` and
  `MEND-AGENT-WORKBENCH-PLAN.md` §5 need amending to match.
- Mend still calls Core with its service key and a derived `ownerUserId`. Core keeps trusting Mend
  as a server caller. Isolation is enforced in Mend; Core's own owner scoping (CORE-03) is later
  hardening, not a precondition for the beta.
- Every internal job resolves authority from durable resource relationships (session owner, project
  organization) and never takes a browser's current user or a raw path or object key.
- Migrations and ADR numbers from the team branch are not reused. The branch's migration test that
  expects `ON DELETE SET NULL` to widen a project to instance scope is the opposite of this
  decision.

## Delivery

One ready-for-review PR per step, stacked:

1. This ADR; the two-organization authorization harness; authorize before stop, before protocol and
   lifecycle disclosure, and before adoption-conflict detail.
2. Organization domain and persistence: schema and migration, membership with the one-organization
   constraint, invitations and the last-owner lock (ported), `MEND_TENANCY`, the operator role,
   closed registration, and the upgrade.
3. `ProjectAccess` on every current-main route, including private/shared visibility, capture-backed
   reads, SSE filtering and link checks.
4. Per-user resources: signer, push devices, notifications, GitHub identity, organization
   references, folders.
5. Runtime identity: hot pool partitioning, shared control, removal and revocation, the audit log.
6. Web and CLI: Members, Folders and References settings; the invitation join flow; recovery links;
   `mend operator`.
7. The multi mode gate: egress and local-source policy, upload length binding, and the startup
   check.

Budgets follow after the private beta opens.
