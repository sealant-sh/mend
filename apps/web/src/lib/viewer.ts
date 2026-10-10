import {
  canRemoveProject,
  canSteerSession,
  canTypeInTerminal,
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

/**
 * Who is looking, keeping "not read yet" apart from "nobody": undefined while
 * `organization.current` is in flight, so a page says nothing about whose a thing is until it
 * knows, instead of drawing the not-the-owner view for a moment.
 */
export const useViewerState = (): Viewer | null | undefined => {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  );
  return current.isPending ? undefined : viewerOf(current.data);
};

export const useViewer = (): Viewer | null => useViewerState() ?? null;

/**
 * What a project on inherit follows: the viewer's organization's defaults over the instance's
 * (docs/adr/0003, "Resources that were instance-global"). An account in no organization reads the
 * instance's. Undefined while loading.
 */
export const useInheritedSettings = () => {
  const trpc = useTRPC();
  const organization = useQuery(
    trpc.organization.settings.queryOptions(undefined, { retry: false }),
  );
  const instance = useQuery({
    ...trpc.settings.get.queryOptions(),
    enabled: organization.isError,
  });
  return organization.data?.effective ?? instance.data;
};

/**
 * What a session row offers this viewer. Unknown viewers get read-only rows. Deleting stays the
 * owner's even while control is shared, and so does anything that types in its terminal
 * (docs/adr/0013).
 */
export const sessionActions = (
  session: SteeringFacts,
  viewer: Viewer | null,
): {
  readonly own: boolean;
  readonly steer: boolean;
  readonly stop: boolean;
  readonly terminalInput: boolean;
} => {
  const steer = viewer !== null && canSteerSession(session, viewer.userId);
  return {
    own: viewer !== null && session.ownerUserId === viewer.userId,
    steer,
    stop: steer || viewer?.role === "owner",
    terminalInput: viewer !== null && canTypeInTerminal(session, viewer.userId),
  };
};

/**
 * The session owner's name from the organization's roster, for saying whose a session is; "its
 * owner" when the roster does not name them, null for a session nobody owns.
 */
export const useOwnerName = (ownerUserId: string | null): string | null => {
  const trpc = useTRPC();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  if (ownerUserId === null) return null;
  return members.data?.find((member) => member.userId === ownerUserId)?.name ?? "its owner";
};

export const canRemove = (project: ProjectTenancy, viewer: Viewer | null): boolean =>
  viewer !== null && canRemoveProject(project, viewer);

/** Where a session was started from, when that was not Mend itself (docs/adr/0006-slack.md). */
const originWords = (origin: SessionOrigin): string | null =>
  origin === "slack" ? "from Slack" : null;

/**
 * The line a session page shows beside its owner: whose credentials it runs on when they are not
 * the viewer's, where it was started from when that was not Mend (`from Slack`), and whether
 * control is shared. Null when there is nothing to say. `own` is the API's word for the viewer
 * (`control.own`). Names come from the roster, undefined while it is read: then a session the
 * viewer does not own says nothing yet, rather than "another account". An owner the roster does
 * not name is "another account".
 */
export const runsAsLine = (
  session: SteeringFacts & { readonly origin: SessionOrigin },
  own: boolean,
  names: ReadonlyMap<string, string> | undefined,
): string | null => {
  const origin = originWords(session.origin);
  const shared = session.sharedControlEnabledAt === null ? null : "shared control on";
  if (session.ownerUserId !== null && !own && names === undefined) return null;
  const owner =
    session.ownerUserId === null
      ? "no owner · nobody steers it"
      : own
        ? null
        : `runs as ${names?.get(session.ownerUserId) ?? "another account"}`;
  const parts = [owner, origin, session.ownerUserId === null ? null : shared].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
};
