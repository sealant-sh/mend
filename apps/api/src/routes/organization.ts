import {
  AccessKeyRefused,
  accessKeyIdOf,
  AccountOrganization,
  AuditEntry,
  CurrentUser,
  InvitationAccepted,
  OneTimeLink,
  InvitationCreated,
  InvitationPreview,
  InvitationSpent,
  MendApi,
  NotFound,
  MemberRemoved,
  OrganizationRejected,
  OrganizationView,
} from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  ResourceArchivesRepo,
  AuditEventsRepo,
  UsersRepo,
  InstanceRolesRepo,
  OrganizationsRepo,
  ProjectsRepo,
  type OrganizationMembership,
} from "@mend/db";
import {
  AUDIT_PAGE_MAX,
  INVITATION_DEFAULT_DAYS,
  INVITATION_MAX_DAYS,
} from "@mend/domain/workbench";
import { handedLinkPath } from "@mend/network";
import { SessionEngine } from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { Clock, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { signInOf } from "../access.ts";
import { MemberRemoval } from "../member-removal.ts";
import { TenancyConfig } from "../tenancy.ts";
import {
  organizationRuntime,
  organizationRuntimeSwitch,
  organizationSettingsView,
  saveOrganizationSessionRuntime,
  saveOrganizationSettings,
  saveOrganizationWorkspaceEnvironment,
} from "./organization-settings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The id a caller-scoped 404 names: the resource the caller asked for, never a parent's. */
const ORGANIZATION = "organization";

/** Days until an invitation expires: the default when omitted, clamped to one day and the max. */
export const invitationDays = (requested: number | undefined): number =>
  Math.min(INVITATION_MAX_DAYS, Math.max(1, requested ?? INVITATION_DEFAULT_DAYS));

/** A plausible address, lowercased, or the reason it is not one. */
export const invitationEmail = (
  value: string | undefined,
): { readonly email: string | null } | { readonly issue: string } => {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === "") return { email: null };
  return /^[^\s@]+@[^\s@]+$/.test(trimmed)
    ? { email: trimmed }
    : { issue: "That does not look like an email address." };
};

const LAST_OWNER =
  "An organization needs an owner. Make someone else an owner before this one steps down.";

const LAST_OWNER_LEAVING =
  "An organization needs an owner. Make someone else an owner before you leave.";

const ONLY_ORGANIZATION =
  "This is your only organization. Ask one of its owners to remove you instead.";

/** An audit page request: the previous page's last event id, and a limit within the maximum. */
export const auditPage = (
  before: string | undefined,
  limit: string | undefined,
): { readonly beforeId: string | null; readonly limit: number } => {
  const count = limit === undefined ? Number.NaN : Number.parseInt(limit, 10);
  return {
    beforeId: before === undefined || before.trim() === "" ? null : before.trim(),
    limit: Number.isNaN(count) ? 50 : Math.min(AUDIT_PAGE_MAX, Math.max(1, count)),
  };
};

export const membership = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const organizations = yield* OrganizationsRepo;
  const found = yield* organizations.activeMembership(signInOf(caller));
  if (found === null) return yield* new NotFound({ id: ORGANIZATION });
  return found;
});

/**
 * An access key never changes who owns the organization: it cannot make an owner, change an
 * owner's role or remove an owner, because the change outlives the key (docs/adr/0023, decision 11).
 */
const refuseOwnershipChangeByKey = (touchesOwner: boolean) =>
  Effect.gen(function* () {
    if (touchesOwner && accessKeyIdOf((yield* CurrentUser).credential) !== undefined) {
      return yield* new AccessKeyRefused({
        message:
          "An access key cannot change who owns this organization. Sign in to Mend, or use a CLI signed in with mend login.",
      });
    }
  });

/** An account in the caller's organization, or 404 for anyone else, before anything moves. */
const memberOf = (organization: OrganizationMembership, userId: string) =>
  Effect.gen(function* () {
    const role = yield* (yield* OrganizationsRepo).roleOf(organization.organization.id, userId);
    if (role === null) return yield* new NotFound({ id: userId });
    return role;
  });

/** The caller's membership when they own the organization; members get the same 404. */
export const ownership = (id: string) =>
  Effect.gen(function* () {
    const found: OrganizationMembership = yield* membership;
    if (found.role !== "owner") return yield* new NotFound({ id });
    return found;
  });

/**
 * The caller's organization (docs/adr/0003-organizations-and-tenancy.md). Members read the roster
 * and the defaults their projects inherit; owners mint and revoke invitation links, remove members,
 * change roles, take over projects a departed member created, set those defaults, and read the
 * audit log.
 */
export const OrganizationGroupLive = HttpApiBuilder.group(MendApi, "organization", (handlers) =>
  handlers
    .handle("current", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        const caller = yield* CurrentUser;
        const organizations = yield* OrganizationsRepo;
        const roles = yield* InstanceRolesRepo;
        return new OrganizationView({
          organization: found.organization,
          userId: caller.user.id,
          role: found.role,
          memberCount: yield* organizations.memberCount(found.organization.id),
          operator: yield* roles.isOperator(caller.user.id),
          tenancy: (yield* TenancyConfig).mode,
          mountDelivery: (yield* DeploymentConfig).sessionStore === "captured" ? "sources" : "bind",
        });
      }),
    )
    .handle("members", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        const organizations = yield* OrganizationsRepo;
        return yield* organizations.members(found.organization.id);
      }),
    )
    .handle("invitations", () =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const organizations = yield* OrganizationsRepo;
        return yield* organizations.listInvitations(found.organization.id);
      }),
    )
    .handle("createInvitation", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const caller = yield* CurrentUser;
        const organizations = yield* OrganizationsRepo;
        const email = invitationEmail(payload.email);
        if ("issue" in email) return yield* new OrganizationRejected({ message: email.issue });
        const minted = yield* organizations
          .createInvitation({
            organizationId: found.organization.id,
            role: payload.role,
            email: email.email,
            createdByUserId: caller.user.id,
            expiresAt: new Date(
              (yield* Clock.currentTimeMillis) + invitationDays(payload.expiresInDays) * DAY_MS,
            ),
          })
          .pipe(
            Effect.catchTag("OrganizationNotFoundError", () => new NotFound({ id: ORGANIZATION })),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "invitation.created",
          subjectType: "invitation",
          subjectId: minted.invitation.id,
          data: { role: payload.role, emailBound: email.email !== null },
        });
        return new InvitationCreated({
          invitation: minted.invitation,
          token: minted.token,
          path: handedLinkPath("invitation", minted.token),
        });
      }),
    )
    .handle("revokeInvitation", ({ params }) =>
      Effect.gen(function* () {
        const found = yield* ownership(params.id);
        const caller = yield* CurrentUser;
        const organizations = yield* OrganizationsRepo;
        const revoked = yield* organizations
          .revokeInvitation(found.organization.id, params.id)
          .pipe(
            Effect.catchTag("InvitationUnknownError", () => new NotFound({ id: params.id })),
            Effect.catchTag("InvitationSpentError", (error) =>
              Effect.fail(new InvitationSpent({ state: error.state })),
            ),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "invitation.revoked",
          subjectType: "invitation",
          subjectId: revoked.id,
        });
        return revoked;
      }),
    )
    .handle("removeMember", ({ params }) =>
      Effect.gen(function* () {
        const found = yield* ownership(params.userId);
        yield* refuseOwnershipChangeByKey((yield* memberOf(found, params.userId)) === "owner");
        const caller = yield* CurrentUser;
        const removed = yield* (yield* MemberRemoval)
          .remove({
            organizationId: found.organization.id,
            userId: params.userId,
            actorUserId: caller.user.id,
          })
          .pipe(
            Effect.catchTag("MemberNotFoundError", () => new NotFound({ id: params.userId })),
            Effect.catchTag(
              "LastOwnerError",
              () => new OrganizationRejected({ message: LAST_OWNER }),
            ),
          );
        return new MemberRemoved({
          sshKeysRemoved: removed.sshKeys.removed,
          sshKeysOutstanding: removed.sshKeys.outstanding,
        });
      }),
    )
    .handle("setMemberRole", ({ params, payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(params.userId);
        const role = yield* memberOf(found, params.userId);
        yield* refuseOwnershipChangeByKey(role === "owner" || payload.role === "owner");
        const caller = yield* CurrentUser;
        const member = yield* (yield* OrganizationsRepo)
          .setRole(found.organization.id, params.userId, payload.role)
          .pipe(
            Effect.catchTag("MemberNotFoundError", () => new NotFound({ id: params.userId })),
            Effect.catchTag(
              "LastOwnerError",
              () => new OrganizationRejected({ message: LAST_OWNER }),
            ),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "member.role_changed",
          subjectType: "member",
          subjectId: params.userId,
          data: { role: payload.role },
        });
        return member;
      }),
    )
    .handle("issuePasswordReset", ({ params }) =>
      Effect.gen(function* () {
        const found = yield* ownership(params.userId);
        const role = yield* memberOf(found, params.userId);
        // An owner resets a member's password, never an owner's and never the operator's: a
        // demoted operator reset by an owner would hand that owner the whole instance.
        if (role === "owner" || (yield* (yield* InstanceRolesRepo).isOperator(params.userId))) {
          return yield* new OrganizationRejected({
            message:
              "Owners and the operator reset their passwords through the operator of this Mend.",
          });
        }
        const caller = yield* CurrentUser;
        const reset = yield* (yield* Auth).issuePasswordReset(params.userId);
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "member.password_reset_issued",
          subjectType: "member",
          subjectId: params.userId,
        });
        return new OneTimeLink({
          path: handedLinkPath("passwordReset", reset.token),
          expiresAt: reset.expiresAt,
        });
      }),
    )
    .handle("orphanedProjects", () =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const members = yield* (yield* OrganizationsRepo).members(found.organization.id);
        const current = new Set(members.map((member) => member.userId));
        const repo = yield* ProjectsRepo;
        // A removed one too: taken over, it is its new creator's to Restore or purge.
        const projects = [
          ...(yield* repo.listForOrganization(found.organization.id)),
          ...(yield* repo.removedForOrganization(found.organization.id)).map(
            ({ project }) => project,
          ),
        ];
        return projects.filter(
          (project) => project.createdByUserId === null || !current.has(project.createdByUserId),
        );
      }),
    )
    .handle("takeOverProject", ({ params }) =>
      Effect.gen(function* () {
        // Looked up by id, not through visibility: a departed member's private project is exactly
        // the one an owner cannot see yet.
        const found = yield* ownership(params.id);
        const caller = yield* CurrentUser;
        const projects = yield* ProjectsRepo;
        const project = yield* projects
          .byId(params.id)
          .pipe(
            Effect.catchTag("ProjectNotFoundError", () =>
              Effect.flatMap(projects.removedById(params.id), (kept) =>
                kept === null ? new NotFound({ id: params.id }) : Effect.succeed(kept.project),
              ),
            ),
          );
        if (project.organizationId !== found.organization.id) {
          return yield* new NotFound({ id: params.id });
        }
        const creator = project.createdByUserId;
        if (creator !== null) {
          const role = yield* (yield* OrganizationsRepo).roleOf(found.organization.id, creator);
          if (role !== null) {
            return yield* new OrganizationRejected({
              message:
                "Its creator still belongs to the organization; only a departed member's project can be taken over.",
            });
          }
        }
        const taken = yield* projects
          .setCreatedBy(params.id, caller.user.id)
          .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id })));
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "project.taken_over",
          subjectType: "project",
          subjectId: params.id,
          data: { fromUserId: creator },
        });
        yield* (yield* SessionEngine).reconcileHotSessions(params.id);
        return taken;
      }),
    )
    .handle("settings", () =>
      Effect.gen(function* () {
        return yield* organizationSettingsView(yield* membership);
      }),
    )
    .handle("runtime", () =>
      Effect.gen(function* () {
        return yield* organizationRuntime((yield* membership).organization.id);
      }),
    )
    .handle("setSettings", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const caller = yield* CurrentUser;
        return yield* saveOrganizationSettings(found, caller.user.id, payload);
      }),
    )
    .handle("runtimeSwitch", ({ query }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const caller = yield* CurrentUser;
        return yield* organizationRuntimeSwitch(
          found,
          caller.user.id,
          query.sessionRuntime ?? null,
        );
      }),
    )
    .handle("setSessionRuntime", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const caller = yield* CurrentUser;
        return yield* saveOrganizationSessionRuntime(
          found,
          caller.user.id,
          payload.sessionRuntime,
          payload.moves,
        );
      }),
    )
    .handle("setWorkspaceEnvironment", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const caller = yield* CurrentUser;
        return yield* saveOrganizationWorkspaceEnvironment(found, caller.user.id, payload);
      }),
    )
    .handle("resourceArchives", () =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        return yield* (yield* ResourceArchivesRepo).list(found.organization.id);
      }),
    )
    .handle("audit", ({ query }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const events = yield* (yield* AuditEventsRepo).listForOrganization(
          found.organization.id,
          auditPage(query.before, query.limit),
        );
        // Accounts are deactivated, never deleted, so a departed member still has a name.
        const users = yield* UsersRepo;
        const names = new Map<string, string>();
        const accounts = new Set(
          events.flatMap((event) =>
            event.subjectType === "member"
              ? [event.actorUserId, event.subjectId]
              : [event.actorUserId],
          ),
        );
        for (const account of accounts) {
          names.set(account, (yield* users.byId(account))?.name ?? "a removed account");
        }
        return events.map(
          (event) =>
            new AuditEntry({
              event,
              actorName: names.get(event.actorUserId) ?? "",
              subjectName:
                event.subjectType === "member" ? (names.get(event.subjectId) ?? null) : null,
            }),
        );
      }),
    ),
);

export const AccountOrganizationsGroupLive = HttpApiBuilder.group(
  MendApi,
  "accountOrganizations",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const organizations = yield* OrganizationsRepo;
          const active = yield* organizations.activeMembership(signInOf(caller));
          const all = yield* organizations.memberships(caller.user.id);
          return all
            .map(
              (held) =>
                new AccountOrganization({
                  ...held,
                  active: held.organization.id === active?.organization.id,
                }),
            )
            .toSorted((a, b) => a.organization.name.localeCompare(b.organization.name));
        }),
      )
      .handle("switch", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const switched = yield* (yield* OrganizationsRepo)
            .switchActive(signInOf(caller), payload.organizationId)
            .pipe(
              Effect.catchTag(
                "MemberNotFoundError",
                () => new NotFound({ id: payload.organizationId }),
              ),
              // The contract refuses a key first (`PersonCredentialOnly`).
              Effect.catchTag("AccessKeyCannotSwitchError", Effect.die),
            );
          return new AccountOrganization({ ...switched, active: true });
        }),
      )
      .handle("leave", ({ params }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const all = yield* (yield* OrganizationsRepo).memberships(caller.user.id);
          if (!all.some((held) => held.organization.id === params.id)) {
            return yield* new NotFound({ id: params.id });
          }
          if (all.length === 1)
            return yield* new OrganizationRejected({ message: ONLY_ORGANIZATION });
          yield* (yield* MemberRemoval)
            .remove({
              organizationId: params.id,
              userId: caller.user.id,
              actorUserId: caller.user.id,
            })
            .pipe(
              Effect.catchTag("MemberNotFoundError", () => new NotFound({ id: params.id })),
              Effect.catchTag(
                "LastOwnerError",
                () => new OrganizationRejected({ message: LAST_OWNER_LEAVING }),
              ),
            );
        }),
      )
      .handle("acceptInvitation", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentUser;
          const organizations = yield* OrganizationsRepo;
          const joined = yield* organizations
            .acceptInvitation(payload.token, { id: caller.user.id, email: caller.user.email })
            .pipe(
              Effect.catchTag("InvitationUnknownError", () => new NotFound({ id: "invitation" })),
              Effect.catchTag("InvitationSpentError", (error) =>
                Effect.fail(new InvitationSpent({ state: error.state })),
              ),
              Effect.catchTag(
                "InvitationNotForYouError",
                () =>
                  new OrganizationRejected({
                    message: "This invitation is for a different email address.",
                  }),
              ),
            );
          yield* (yield* AuditEventsRepo).record({
            organizationId: joined.organization.id,
            actorUserId: caller.user.id,
            action: "invitation.accepted",
            subjectType: "member",
            subjectId: caller.user.id,
            data: { role: joined.member.role },
          });
          yield* organizations
            .switchActive(signInOf(caller), joined.organization.id)
            .pipe(Effect.orDie);
          return new InvitationAccepted({
            organization: joined.organization,
            role: joined.member.role,
          });
        }),
      ),
);

/** The join page's read, before the visitor has an account. Unknown tokens are 404. */
export const InvitationsGroupLive = HttpApiBuilder.group(MendApi, "invitations", (handlers) =>
  handlers.handle("preview", ({ payload }) =>
    Effect.gen(function* () {
      const organizations = yield* OrganizationsRepo;
      const resolved = yield* organizations
        .invitationByToken(payload.token)
        .pipe(Effect.catchTag("InvitationUnknownError", () => new NotFound({ id: "invitation" })));
      return new InvitationPreview({
        organizationId: resolved.organization.id,
        organizationName: resolved.organization.name,
        role: resolved.invitation.role,
        state: resolved.state,
        expiresAt: resolved.invitation.expiresAt,
      });
    }),
  ),
);
