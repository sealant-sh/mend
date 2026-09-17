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
import { InstanceRolesRepo, OrganizationsRepo, type OrganizationMembership } from "@mend/db";
import { INVITATION_DEFAULT_DAYS, INVITATION_MAX_DAYS } from "@mend/domain/workbench";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

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

/** The caller's membership, or 404: an account in no organization sees none. */
const membership = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const organizations = yield* OrganizationsRepo;
  const found = yield* organizations.membershipOf(caller.user.id);
  if (found === null) return yield* new NotFound({ id: ORGANIZATION });
  return found;
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
 * owners mint and revoke invitation links. Removal, role changes and recovery land with member
 * removal, because removing someone honestly needs revocation to exist.
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
        const organizations = yield* OrganizationsRepo;
        return yield* organizations.revokeInvitation(found.organization.id, params.id).pipe(
          Effect.catchTag("InvitationUnknownError", () => new NotFound({ id: params.id })),
          Effect.catchTag("InvitationSpentError", (error) =>
            Effect.fail(new InvitationSpent({ state: error.state })),
          ),
        );
      }),
    ),
);

/** The join page's read, before the visitor has an account. Unknown tokens are 404. */
export const InvitationsGroupLive = HttpApiBuilder.group(MendApi, "invitations", (handlers) =>
  handlers.handle("preview", ({ params }) =>
    Effect.gen(function* () {
      const organizations = yield* OrganizationsRepo;
      const resolved = yield* organizations
        .invitationByToken(params.token)
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
