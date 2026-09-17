import {
  CurrentUser,
  InvitationCreated,
  InvitationPreview,
  InvitationSpent,
  MendApi,
  NotFound,
  OrganizationRejected,
  OrganizationView,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
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
import { SessionEngine } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { MemberRemoval } from "../member-removal.ts";

/** The path a browser opens to accept an invitation; the web app owns the route. */
export const invitationJoinPath = (token: string) => `/join/${token}`;

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

/** An audit page request: a valid `before` time and a limit within the page maximum. */
export const auditPage = (
  before: string | undefined,
  limit: string | undefined,
): { readonly before: Date | null; readonly limit: number } => {
  const at = before === undefined ? null : new Date(before);
  const count = limit === undefined ? Number.NaN : Number.parseInt(limit, 10);
  return {
    before: at === null || Number.isNaN(at.getTime()) ? null : at,
    limit: Number.isNaN(count) ? 50 : Math.min(AUDIT_PAGE_MAX, Math.max(1, count)),
  };
};

/** The caller's membership, or 404: an account in no organization sees none. */
const membership = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const organizations = yield* OrganizationsRepo;
  const found = yield* organizations.membershipOf(caller.user.id);
  if (found === null) return yield* new NotFound({ id: ORGANIZATION });
  return found;
});

/** An account in the caller's organization, or 404 for anyone else, before anything moves. */
const memberOf = (organization: OrganizationMembership, userId: string) =>
  Effect.gen(function* () {
    const role = yield* (yield* OrganizationsRepo).roleOf(organization.organization.id, userId);
    if (role === null) return yield* new NotFound({ id: userId });
    return role;
  });

/** The caller's membership when they own the organization; members get the same 404. */
const ownership = (id: string) =>
  Effect.gen(function* () {
    const found: OrganizationMembership = yield* membership;
    if (found.role !== "owner") return yield* new NotFound({ id });
    return found;
  });

/**
 * The caller's organization (docs/adr/0003-organizations-and-tenancy.md). Members read the roster;
 * owners mint and revoke invitation links, remove members, change roles, take over projects a
 * departed member created, and read the audit log.
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
          role: found.role,
          memberCount: yield* organizations.memberCount(found.organization.id),
          operator: yield* roles.isOperator(caller.user.id),
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
            expiresAt: new Date(Date.now() + invitationDays(payload.expiresInDays) * DAY_MS),
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
          path: invitationJoinPath(minted.token),
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
        yield* memberOf(found, params.userId);
        const caller = yield* CurrentUser;
        yield* (yield* MemberRemoval)
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
      }),
    )
    .handle("setMemberRole", ({ params, payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership(params.userId);
        yield* memberOf(found, params.userId);
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
    .handle("orphanedProjects", () =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        const members = yield* (yield* OrganizationsRepo).members(found.organization.id);
        const current = new Set(members.map((member) => member.userId));
        const projects = yield* (yield* ProjectsRepo).listForOrganization(found.organization.id);
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
          .pipe(Effect.catchTag("ProjectNotFoundError", () => new NotFound({ id: params.id })));
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
    .handle("audit", ({ query }) =>
      Effect.gen(function* () {
        const found = yield* ownership(ORGANIZATION);
        return yield* (yield* AuditEventsRepo).listForOrganization(
          found.organization.id,
          auditPage(query.before, query.limit),
        );
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
        organizationName: resolved.organization.name,
        role: resolved.invitation.role,
        state: resolved.state,
        expiresAt: resolved.invitation.expiresAt,
      });
    }),
  ),
);
