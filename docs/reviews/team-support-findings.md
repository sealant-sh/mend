# Team support findings

Review date: 2026-09-16.

## Decision

**Keep the implementation, but do not enable invitations for less-trusted users yet.** It has useful
team, invitation and project-access foundations. It does not yet provide a complete boundary between
accounts or teams.

Port the work onto current capture-backed main in small PRs. Do not merge the older route and
session-engine files wholesale. Fix authorization ordering, indirect access, credential isolation,
account deletion and active revocation before treating a team invitation as access to only the
selected projects.

The [public exposure findings](public-exposure-findings.md) cover problems inherited from released
Mend and Core. Adding team checks alone does not fix instance-global signers, notifications,
operator settings, resource limits or Core's administrative delegation model.

## Snapshot and evidence

The reviewed input was the dirty `yp/mend-team-bs` branch at:

```text
/home/yiannis/.herdr/worktrees/Mend/yp-mend-team-bs
```

Its base was `ade9996213d11e2007f9554346c2c8ab114c87c6`. A separate snapshot preserved 43 modified
tracked files and 16 untracked additions. The original worktree was not edited, rebased, committed
or pushed. Tests ran in a disposable copy, not against the original worktree or live users.

Comparison target was Mend main at `6a2c50ec4`. That commit was 21 commits ahead of the snapshot
base, with 154 changed paths and 17 overlaps with the dirty team changes. These are review-time
counts, not claims about today's mutable branch or main.

Labels used below:

- **Observed:** directly present in the reviewed source or schema.
- **Reproduced:** exercised in local tests.
- **Source-inferred:** a consequence of inspected control flow, not a live cross-user test.
- **Proposed:** behavior or a fix that has not shipped.

The source paths below refer to the team snapshot unless explicitly marked as current-main paths.
Some new files therefore do not exist in the reviewed main checkout.

## Foundations worth keeping

| Area             | Observed implementation                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain           | `Team`, `TeamMember`, `TeamInvite`, owner/member roles and personal/team/instance project scope.                                             |
| Invitations      | Random 32-byte bearer tokens, hashes at rest, expiry, optional normalized email binding, revoke state, row-locked acceptance and single use. |
| Owner operations | Per-team advisory transaction lock for last-owner mutations through the team repository.                                                     |
| Authorization    | Central `ProjectAccess` resolves project/session/worktree/change access and hides inaccessible rows behind 404 responses.                    |
| API              | Broad checks across project settings, sessions, review, processes, worktrees and connection setup, with important exceptions below.          |
| Browser and CLI  | Team list/detail, roster/invites, join page, scope-aware adoption and labels; CLI adoption scope selection.                                  |
| Events           | SSE project/user/team filtering, although access-loss notification and connection revocation are incomplete.                                 |
| Session identity | New sessions generally keep their creator's Git, dotfiles, skills, Sealant and provider identity. Hot-pool provisioning is an exception.     |

This is more than a team-management UI. The central access service and repository concurrency work
are good starting points for the missing guarantees.

## Blocking findings

### B1. Authorize before stopping a session

**Observed.** In `apps/api/src/routes/workbench.ts`, the stop handler calls `engine.stop` before
`access.session`. A later 404 does not undo the effect.

Resolve authorized access first. A regression must prove that an unrelated caller gets 404 and that
the engine was never called. Apply the same ordering rule to every mutation and platform call.

### B2. Linked projects need authorization at creation and use

**Observed; downstream consequences source-inferred.** Link creation authorizes the source project,
then resolves the target through `ProjectsRepo` rather than `ProjectAccess`. Stored links can later
supply a target worktree to callers who cannot access that target.

Checking both projects when the link is created is necessary but insufficient. Access can change,
and another member of the source project may not have access to the target.

Proposed conservative rule: initially permit links only within the same scope. If cross-scope links
are required, authorize the session owner against both projects on every launch, pool claim and
restore. Define what happens to existing links after target re-scoping or membership removal.

### B3. Ordinary membership must not grant arbitrary host mounts

**Observed.** A project member can configure an absolute host directory. Shape and filesystem checks
do not establish permission to share that directory.

Choose an operator-owned allowlist, predefined selectable mounts, or disable these mounts for
multi-account operation. Resolve symlinks and real paths before enforcing allowed roots. Project
membership must not silently grant access to the machine's homes, store, credentials, runtime
sockets or other repositories. Keep downstream runtime mount restrictions as another boundary.

### B4. Hot pools use the first account rather than the authorized session owner

**Observed; exposure consequences source-inferred.** Reconciliation uses
`userDotfilesRepo.firstUserId()` and provisions under that Sealant principal. Pool claims check
owner equality, but that does not fix provisioning a different user's project material under the
first account. Inputs can include project secrets, environment, mounts, skills and personal
credentials.

Immediate containment can disable affected warming. The complete design should partition pools by
`projectId`, `ownerUserId` and input fingerprint, authorize before provisioning/claiming, and drain
entries when access changes. Never reassign a credential-bearing workspace to another user.

### B5. Revocation must reach existing connections and executors

**Observed; continuing-access consequences source-inferred.** TTY and service-tunnel checks happen
before upgrade. Membership removal and project re-scoping do not consistently close existing
connections, stop affected sessions or revoke their executor/capture grants.

Proposed default:

1. Deny new requests immediately and close the removed user's sockets.
2. Stop new capture grants and presigned-URL issuance under revoked authority.
3. Checkpoint/flush and suspend or stop sessions whose owner no longer has project access, using the
   normal lifecycle. Do not bypass capture durability to force cleanup.
4. Send an account-scoped access-change event so clients invalidate caches and close panes.

The safe shutdown protocol and treatment of the removed owner's credentials need an explicit product
decision. Already downloaded data cannot be recalled. Issued presigned URLs retain a bounded
residual lifetime; verify the actual expiry rather than relying on an ADR estimate.

### B6. Account deletion currently widens personal-project access

**Observed.** The project owner foreign key uses `ON DELETE SET NULL`; null owner plus null team
means instance scope. The migration test explicitly expects this transition.

Deleting an account must not publish its personal projects to everyone else. Choose explicit
transfer, a tombstoned owner, archive/lock, or deliberate deletion. Test the chosen behavior through
account deletion, not only normal project-management methods.

### B7. Reference repositories are still global mutable resources

**Observed.** The reference list exposes origin and store-path metadata. Any authenticated account
can add, refresh, remove or select references. Project authorization controls selection on a
project, not ownership of the referenced repository.

Scope references to an owner/team/project, or make them operator-managed. Define how existing rows
migrate. Refresh must not fall back to another user's ambient Git identity.

### B8. TTY and tunnel responses disclose state before authorization

**Observed.** Some protocol and lifecycle checks return a state-specific response before the project
check. This distinguishes an inaccessible existing target from an absent one.

After authentication and row lookup, authorize the inherited project before disclosing protocol,
workspace or lifecycle state. Test uniform inaccessible-resource responses on raw upgrade routes,
not just typed API handlers.

### B9. Raw service ports do not enforce team permissions

**Observed.** An authenticated service tunnel can enforce project access. A separately reachable raw
listener has no Mend authorization and does not inherit that tunnel's checks.

Keep raw exposure disabled or separately authenticated. Document it as a distinct network
capability. Team membership and revocation cannot protect a development server reached through an
unrestricted raw port.

### B10. Any account can claim a legacy instance project

**Observed.** The snapshot lets every account manage instance-scoped projects, including moving one
to their personal scope or a team they belong to. Multi-account upgrades retain legacy projects as
instance-scoped.

Introduce operator authority or an explicit claim/transfer process before allowing this transition.
The old shared-machine trust model is not an adequate ownership policy for teams.

### B11. Adoption conflicts disclose inaccessible project metadata

**Observed.** Name-conflict lookup precedes authorization and can reveal an existing project's
absolute store path.

Return a generic name-unavailable response without private path or scope detail. Decide separately
whether project names remain machine-global or become scope-qualified; that affects store layout,
links, CLI lookup and migration.

### B12. Database constraints do not enforce the stated model

**Observed.** Missing invariants include exclusive personal/team scope, valid role values and
consistent invitation acceptance fields. Account deletion can cascade memberships outside the
repository's last-owner lock and leave an ownerless team.

Add appropriate schema checks and an account-deletion/last-owner recovery policy. Test concurrent
invite acceptance, revocation, owner removal, account deletion and team deletion. Repository locks
are useful but do not cover alternate mutation paths by themselves.

## Important product decisions

These choices should be settled before implementing permissions piecemeal:

| Decision                        | Recommended starting position, not an approved contract                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance operator               | Explicit authority for machine settings, recovery, host mounts and legacy project ownership. Team ownership does not imply machine administration. |
| Member permissions              | Separate ordinary work/review from changing execution credentials, privileged bindings, mounts or project scope.                                   |
| Controlling an existing session | State clearly that collaborators act through that session owner's live provider/Git authority and can incur their spend.                           |
| Removed session owner           | Prefer durable checkpoint/flush then suspend/stop, rather than silently retaining use of the removed person's credentials.                         |
| Cross-scope links               | Refuse initially; add only with a clear per-launch authorization model.                                                                            |
| References                      | Scoped resources or operator-managed resources, not a universally mutable list.                                                                    |
| Account deletion                | No automatic widening of visibility; require a defined retention/transfer outcome.                                                                 |
| Team switching                  | A navigation filter unless a separate server-side model is deliberately introduced. Never trust browser selection as authorization.                |
| Names                           | Use stable IDs in automation; decide normalization and uniqueness before relying on display names.                                                 |

Other UI gaps include management controls shown to members whom the API refuses, stale views after
access loss, and invitation previews that disclose the bound email to any authenticated token
holder. The latter is a privacy decision, not proof that token validation is broken.

Membership, invitation, scope, mount/link and session-control changes also need durable actor audit.
Invalidation events alone do not record who changed authority.

## Porting onto capture-backed main

The snapshot predates the capture-store implementation. Current-main review reads use
`WorktreeReads`, captured `SessionRepository`, `CaptureRuntime`, durable pointers, leases, flush,
replan and retention behavior. Preserve those abstractions.

Required integration rules:

- Authorize the entire parent chain before capture-backed reads, summaries, store-ref resolution or
  user-triggered blob access.
- Preserve capture IDs, sequence stamps and partial/observed evidence in API views.
- Keep executor tokens worktree-bound and couple grant issuance to the chosen revocation policy.
- Change pointer authorization when re-scoping a project. Moving S3 objects is not necessary to
  change permissions, and object prefixes are not permission checks.
- Preserve capture-aware deletion and cleanup. Do not restore filesystem-only removal handlers.
- Keep internal jobs separate from a browser's `CurrentUser`; jobs should resolve durable resource
  relationships and authority rather than accept arbitrary paths or object keys.

Concrete merge hazards at the reviewed main commit:

- Main already uses migrations `0053_capture_store` and `0054_project_install_command`. Allocate the
  next free migration after checking the target branch; do not overwrite or renumber shipped ones.
- Main already has ADR `0002` for the capture store. Give the team ADR a free number.
- Preserve `Project.installCommand` through domain, persistence, contracts and UI.
- Seventeen edited paths overlap newer main changes. The session engine changed substantially; port
  the ownership requirements, not the old engine or its tests wholesale.
- Test upgrades from the current capture/install schema, not just the snapshot's old schema.

## Suggested small-PR sequence

1. **Authorization regression harness.** Two synthetic users and projects. Fix
   authorize-before-stop, target-link checks, pre-upgrade disclosure and adoption-conflict details.
   Keep invitations off.
2. **Operator boundary.** Gate machine settings and project claiming; constrain mounts, references
   and raw listeners. Scope existing global signers and notifications from main.
3. **Domain and persistence.** Port team types/repositories/contracts onto current main, with valid
   scope/role constraints, non-widening deletion and owner recovery. Add the correctly numbered
   migration.
4. **Current-main route authorization.** Port `ProjectAccess` around current read/write
   abstractions, including indirect IDs, capture-backed review and event delivery. Prove refusal
   prevents effects.
5. **Runtime identity and revocation.** Partition hot pools, check links at use time, scope
   references, close affected connections and couple capture/session grants to access loss.
6. **Join and management UX.** Capability-aware controls, signed-out invitation flow, client
   access-loss invalidation, clear session-owner delegation and the fixture typecheck repair.
7. **Pilot acceptance.** Audit trail, recovery documentation, migration tests, forced repository
   gates and two-user capture-mode acceptance before inviting less-trusted users.

## Verification and missing coverage

Recorded passing tests from the disposable copy:

| Check                               | Result                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| Team domain                         | 8 tests                                                 |
| Team repository with local Postgres | 4 tests                                                 |
| Migrations                          | 7 tests                                                 |
| API contracts                       | 21 tests                                                |
| Web                                 | 75 tests, with a delayed-close warning                  |
| Web production build                | Passed                                                  |
| Relevant package typechecks         | Domain, DB, API contracts, sessions, API and CLI passed |
| Forced monorepo lint                | 22 packages passed                                      |

Full typecheck did **not** pass. After route generation, three web fixture errors remain in
`apps/web/src/components/projects-index/model.test.ts`: the fixture supplies only a team's ID/name
where the complete team object is required. An earlier full run also encountered missing generated
route trees and a Turbo/tsgo crash. Focused successes do not replace a passing forced full gate.

Missing acceptance tests:

- Two-user direct/indirect endpoint denials, asserting both inaccessible responses and no effects.
- Link creation, launch and restore after scope or membership changes.
- Operator mount policy and scoped reference mutation.
- Hot-pool separation of credentials, secrets, dotfiles, skills and capture state.
- Active TTY/tunnel revocation, event ordering, cache invalidation and device revocation.
- Concurrent invite/owner/deletion operations and preservation of personal-project privacy.
- Upgrade from the current-main schema while preserving capture data and install settings.
- Capture read and URL-minting denial after access loss, with measured residual URL lifetime.
- Signed-out invitation through registration/welcome/acceptance, including wrong-email and reused
  invitation cases.

No route-level two-user suite demonstrated the whole boundary. Passing domain and repository tests
is not evidence that the HTTP, WebSocket, worker and executor paths all enforce it.

## Intended everyday behavior

An owner creates a team and adopts a repository using their own Git identity. A teammate accepts an
invitation with a separate account and sees only authorized projects. New sessions use their
creator's credentials. Collaborating on an existing session has explicit delegation semantics.

The same person can review or control authorized work from a phone. Removing their membership blocks
new requests, closes existing access and invalidates the client view. Sessions using their identity
follow the chosen durable shutdown policy. Deleting their account does not make personal projects
public, and team projects retain a valid owner or enter an explicit recovery state.

That is the boundary to test before calling this proper team support. The reviewed branch is a
useful foundation for it, not the finished implementation.
