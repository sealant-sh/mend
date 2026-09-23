import {
  canRemoveProject,
  canSteerSession,
  type ProjectTenancy,
  type SessionOrigin,
  type SteeringFacts,
  type Viewer,
} from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";

import type { OrganizationViewDto } from "./api.ts";
import { useTRPC } from "./trpc.ts";

/**
 * Who is looking (docs/adr/0003-organizations-and-tenancy.md), for lists that carry no per-row
 * capabilities: menus and rows decide with the same domain rules the API enforces. Detail pages
 * prefer the capabilities the API returned.
 */
export const viewerOf = (view: OrganizationViewDto | undefined): Viewer | null =>
  view === undefined
    ? null
    : { userId: view.userId, organizationId: view.organization.id, role: view.role };

export const useViewer = (): Viewer | null => {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  );
  return viewerOf(current.data);
};

/**
 * What a session row offers this viewer. Unknown viewers get read-only rows. Deleting stays the
 * owner's even while control is shared.
 */
export const sessionActions = (
  session: SteeringFacts,
  viewer: Viewer | null,
): { readonly own: boolean; readonly steer: boolean; readonly stop: boolean } => {
  const steer = viewer !== null && canSteerSession(session, viewer.userId);
  return {
    own: viewer !== null && session.ownerUserId === viewer.userId,
    steer,
    stop: steer || viewer?.role === "owner",
  };
};

export const canRemove = (project: ProjectTenancy, viewer: Viewer | null): boolean =>
  viewer !== null && canRemoveProject(project, viewer);

/** Where a session was started from, when that was not Mend itself (docs/adr/0006-slack.md). */
const originWords = (origin: SessionOrigin): string | null =>
  origin === "slack" ? "from Slack" : null;

/**
 * The line a session page shows beside its owner: whose credentials it runs on when they are not
 * the viewer's, where it was started from when that was not Mend (`from Slack`), and whether
 * control is shared. Null when there is nothing to say. Names come from the roster; an unknown
 * owner is "another account".
 */
export const runsAsLine = (
  session: SteeringFacts & { readonly origin: SessionOrigin },
  viewerUserId: string | null,
  names: ReadonlyMap<string, string>,
): string | null => {
  const origin = originWords(session.origin);
  const shared = session.sharedControlEnabledAt === null ? null : "shared control on";
  const owner =
    session.ownerUserId === null
      ? "no owner · nobody steers it"
      : session.ownerUserId === viewerUserId
        ? null
        : `runs as ${names.get(session.ownerUserId) ?? "another account"}`;
  const parts = [owner, origin, session.ownerUserId === null ? null : shared].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
};
