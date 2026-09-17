import type { OrganizationsRepo } from "@mend/db";
import { canSeeProject, type ProjectTenancy } from "@mend/domain/workbench";
import { Duration, Effect } from "effect";

/**
 * Mend's own dependency install session. It runs as the account that asked for it, but says
 * nothing about who works in the project, so the hot pool does not count it.
 */
export const INSTALL_SESSION_LABEL = "install · mend";

/** How far back a session makes its owner one the hot pool warms for. */
export const HOT_POOL_RECENT_OWNER_WINDOW = Duration.days(7);

/** The most owners one project's pool warms for at once, most recent first. */
export const HOT_POOL_MAX_OWNERS = 4;

/**
 * Whether `userId` may run sessions in `project` right now (docs/adr/0003-organizations-and-tenancy.md):
 * a member of the project's organization who can see it. Machine work checks this before acting as
 * an account: a hot pool warming, a claim, a queued job.
 */
export const mayRunIn = (
  organizations: OrganizationsRepo["Service"],
  project: ProjectTenancy,
  userId: string,
): Effect.Effect<boolean> =>
  organizations.membershipOf(userId).pipe(
    Effect.map(
      (membership) =>
        membership !== null &&
        canSeeProject(project, {
          userId,
          organizationId: membership.organization.id,
          role: membership.role,
        }),
    ),
  );
