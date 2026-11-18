import { AuditEventsRepo, OrganizationsRepo } from "@mend/db";
import { organizationNameIssue, type Organization } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { TenancyConfig } from "./tenancy.ts";

/** `MEND_TENANCY=single`: the server runs one organization and nobody creates a second. */
export class SingleOrganizationError extends Schema.TaggedError<SingleOrganizationError>()(
  "SingleOrganizationError",
  {},
) {}

/** The name is empty once trimmed, or not allowed; the message says which rule. */
export class OrganizationNameRefusedError extends Schema.TaggedError<OrganizationNameRefusedError>()(
  "OrganizationNameRefusedError",
  { reason: Schema.Literals(["empty", "not-allowed"]), message: Schema.String },
) {}

/**
 * Create an organization (docs/adr/0003-organizations-and-tenancy.md): the one path behind the
 * operator's `POST /operator/organizations` and a person's `POST /account/organizations`. Same
 * name rules, same row, same `organization.created` entry in its audit log. Nothing else is seeded:
 * a new organization's settings, runtime and starting image are the server's until an owner sets
 * its own. With `owner`, the actor is its owner from the same transaction; without, it starts
 * empty and the operator invites its first owner. Who may call it is the caller's to check.
 */
export const createOrganization = Effect.fn("createOrganization")(function* (input: {
  readonly name: string;
  readonly actorUserId: string;
  readonly owner: boolean;
}) {
  if ((yield* TenancyConfig).mode !== "multi") return yield* new SingleOrganizationError();
  const issue = organizationNameIssue(input.name);
  if (issue !== null) return yield* new OrganizationNameRefusedError(issue);
  const created: Organization = yield* (yield* OrganizationsRepo).create(
    input.name.trim(),
    input.actorUserId,
    input.owner ? input.actorUserId : undefined,
  );
  yield* (yield* AuditEventsRepo).record({
    organizationId: created.id,
    actorUserId: input.actorUserId,
    action: "organization.created",
    subjectType: "organization",
    subjectId: created.id,
    data: { name: created.name },
  });
  return created;
});
