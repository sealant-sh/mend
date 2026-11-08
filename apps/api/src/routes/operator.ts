import {
  MendApi,
  ExposureGateItem,
  ExposureReport,
  MultiModeGateItem,
  NotFound,
  OneTimeLink,
  OrganizationRejected,
  OrganizationSummary,
  CurrentUser,
} from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { AuditEventsRepo, OrganizationsRepo, UsersRepo } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { organizationNameIssue } from "@mend/domain/workbench";
import { handedLinkPath } from "@mend/network";
import { Clock, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { ExposureConfig } from "../exposure.ts";
import { TenancyConfig } from "../tenancy.ts";
import { invitationDays, invitationEmail } from "./organization.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATOR = "operator";

const rejected = (message: string) => new OrganizationRejected({ message });

/** The operator's own id, after refusing everyone else with the same 404. */
const operator = Effect.gen(function* () {
  yield* (yield* ProjectAccess).requireOperator(OPERATOR);
  return (yield* CurrentUser).user.id;
});

const organizationOr404 = (id: OrganizationId) =>
  Effect.gen(function* () {
    return yield* (yield* OrganizationsRepo)
      .byId(id)
      .pipe(Effect.catchTag("OrganizationNotFoundError", () => new NotFound({ id })));
  });

/**
 * Operator recovery (docs/adr/0003-organizations-and-tenancy.md). Organization content stays out
 * of reach: these acts name organizations, bring in an owner, and reset a password, and each is
 * recorded in the affected organization's audit log so its owners see what the operator did.
 */
export const OperatorGroupLive = HttpApiBuilder.group(MendApi, "operator", (handlers) =>
  handlers
    .handle("exposure", () =>
      Effect.gen(function* () {
        yield* operator;
        const exposure = yield* ExposureConfig;
        const gate = yield* exposure.gate;
        return new ExposureReport({
          declared: exposure.exposure,
          items: gate.map(
            ({ id, established, detail, fix, blocksStart }) =>
              new ExposureGateItem({ id, established, detail, fix, blocksStart }),
          ),
        });
      }),
    )
    .handle("gate", () =>
      Effect.gen(function* () {
        yield* operator;
        const gate = yield* (yield* TenancyConfig).gate;
        return gate.map((outcome) => new MultiModeGateItem(outcome));
      }),
    )
    .handle("organizations", () =>
      Effect.gen(function* () {
        yield* operator;
        const rows = yield* (yield* OrganizationsRepo).listWithCounts();
        return rows.map((row) => new OrganizationSummary(row));
      }),
    )
    .handle("createOrganization", ({ payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        if ((yield* TenancyConfig).mode !== "multi") {
          return yield* rejected(
            "This Mend runs one organization (MEND_TENANCY=single). Rename it instead.",
          );
        }
        const issue = organizationNameIssue(payload.name);
        if (issue !== null) return yield* rejected(issue);
        const created = yield* (yield* OrganizationsRepo)
          .create(payload.name.trim(), actor)
          .pipe(
            Effect.catchTag("OrganizationNameTakenError", () =>
              Effect.fail(rejected(`An organization named "${payload.name.trim()}" exists.`)),
            ),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: created.id,
          actorUserId: actor,
          action: "organization.created",
          subjectType: "organization",
          subjectId: created.id,
          data: { name: created.name },
        });
        return created;
      }),
    )
    .handle("renameOrganization", ({ params, payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        const issue = organizationNameIssue(payload.name);
        if (issue !== null) return yield* rejected(issue);
        const renamed = yield* (yield* OrganizationsRepo)
          .rename(params.id, payload.name.trim())
          .pipe(
            Effect.catchTag("OrganizationNotFoundError", () => new NotFound({ id: params.id })),
            Effect.catchTag("OrganizationNameTakenError", () =>
              Effect.fail(rejected(`An organization named "${payload.name.trim()}" exists.`)),
            ),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: renamed.id,
          actorUserId: actor,
          action: "organization.renamed",
          subjectType: "organization",
          subjectId: renamed.id,
          data: { name: renamed.name },
        });
        return renamed;
      }),
    )
    .handle("inviteOwner", ({ params, payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        const organization = yield* organizationOr404(params.id);
        const email = invitationEmail(payload.email);
        if ("issue" in email) return yield* rejected(email.issue);
        const minted = yield* (yield* OrganizationsRepo)
          .createInvitation({
            organizationId: organization.id,
            role: "owner",
            email: email.email,
            createdByUserId: actor,
            expiresAt: new Date(
              (yield* Clock.currentTimeMillis) + invitationDays(payload.expiresInDays) * DAY_MS,
            ),
          })
          .pipe(
            Effect.catchTag("OrganizationNotFoundError", () => new NotFound({ id: params.id })),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: organization.id,
          actorUserId: actor,
          action: "invitation.created",
          subjectType: "invitation",
          subjectId: minted.invitation.id,
          data: { role: "owner", emailBound: email.email !== null, byOperator: true },
        });
        return new OneTimeLink({
          path: handedLinkPath("invitation", minted.token),
          expiresAt: minted.invitation.expiresAt,
        });
      }),
    )
    .handle("grantOwner", ({ params, payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        const organization = yield* organizationOr404(params.id);
        const account = yield* (yield* UsersRepo).byEmail(payload.email);
        const organizations = yield* OrganizationsRepo;
        const role =
          account === null ? null : yield* organizations.roleOf(organization.id, account.id);
        if (account === null || role === null) {
          return yield* rejected(
            `No member of ${organization.name} has that email. Invite an owner instead.`,
          );
        }
        if (role === "owner") return;
        yield* organizations.setRole(organization.id, account.id, "owner").pipe(
          Effect.catchTag("MemberNotFoundError", () =>
            Effect.fail(
              rejected(
                `No member of ${organization.name} has that email. Invite an owner instead.`,
              ),
            ),
          ),
          // Promoting can never leave an organization without an owner.
          Effect.catchTag("LastOwnerError", () => Effect.die("promotion refused as last owner")),
        );
        yield* (yield* AuditEventsRepo).record({
          organizationId: organization.id,
          actorUserId: actor,
          action: "recovery.owner_granted",
          subjectType: "member",
          subjectId: account.id,
        });
      }),
    )
    .handle("addMember", ({ params, payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        if ((yield* TenancyConfig).mode !== "multi") {
          return yield* rejected(
            "This Mend runs one organization (MEND_TENANCY=single). Invite people with a link instead.",
          );
        }
        const organization = yield* organizationOr404(params.id);
        const organizations = yield* OrganizationsRepo;
        const account = yield* (yield* UsersRepo).byEmail(payload.email);
        const elsewhere = account === null ? [] : yield* organizations.memberships(account.id);
        if (account === null || elsewhere.length === 0) {
          return yield* rejected(
            "No active account in an organization has that email. Invite them instead.",
          );
        }
        yield* organizations.addMember(organization.id, account.id, payload.role, actor).pipe(
          Effect.catchTag("OrganizationNotFoundError", () => new NotFound({ id: params.id })),
          Effect.catchTag("AlreadyInOrganizationError", () =>
            Effect.fail(rejected(`That account already belongs to ${organization.name}.`)),
          ),
        );
        yield* (yield* AuditEventsRepo).record({
          organizationId: organization.id,
          actorUserId: actor,
          action: "member.added",
          subjectType: "member",
          subjectId: account.id,
          data: { role: payload.role, byOperator: true },
        });
      }),
    )
    .handle("issuePasswordReset", ({ payload }) =>
      Effect.gen(function* () {
        const actor = yield* operator;
        const account = yield* (yield* UsersRepo).byEmail(payload.email);
        const memberships =
          account === null ? [] : yield* (yield* OrganizationsRepo).memberships(account.id);
        if (account === null || memberships.length === 0) {
          return yield* rejected("No active account in an organization has that email.");
        }
        const reset = yield* (yield* Auth).issuePasswordReset(account.id);
        for (const membership of memberships) {
          yield* (yield* AuditEventsRepo).record({
            organizationId: membership.organization.id,
            actorUserId: actor,
            action: "recovery.password_reset_issued",
            subjectType: "member",
            subjectId: account.id,
          });
        }
        return new OneTimeLink({
          path: handedLinkPath("passwordReset", reset.token),
          expiresAt: reset.expiresAt,
        });
      }),
    ),
);
