import { canSteerSession } from "@mend/domain/workbench";
import { queryOptions, useQuery } from "@tanstack/react-query";

import {
  currentOrganization,
  organizationMembers,
  type SessionControlDto,
  type SessionDto,
} from "#/lib/api";

/**
 * Who is looking (docs/adr/0003-organizations-and-tenancy.md). Lists carry no per-session
 * capabilities, so rows and menus decide with the domain's own steering rule, as the web app's
 * lists do; a session's own pane prefers the `control` its detail returned.
 */
export interface Viewer {
  readonly userId: string;
  readonly role: "owner" | "member";
}

export const viewerQuery = queryOptions({
  queryKey: ["viewer"],
  queryFn: async (): Promise<Viewer> => {
    const view = await currentOrganization();
    return { userId: view.userId, role: view.role };
  },
  staleTime: 60_000,
  retry: false,
});

export const membersQuery = queryOptions({
  queryKey: ["viewer", "members"],
  queryFn: organizationMembers,
  staleTime: 60_000,
  retry: false,
});

export const useViewer = (): Viewer | null => useQuery(viewerQuery).data ?? null;

/** Whose session it is, by name when the roster answers; null for a session with no owner. */
export const useOwnerName = (session: SessionDto | null): string | null => {
  const members = useQuery(membersQuery);
  if (session === null || session.ownerUserId === null) return null;
  return members.data?.find((member) => member.userId === session.ownerUserId)?.name ?? "its owner";
};

/**
 * What a session row offers this viewer, by the rules the API enforces: delete is the owner's
 * even while control is shared; steering is the owner's, or everyone's while shared; stop is
 * also an organization owner's. An unknown viewer gets a read-only row.
 */
export const sessionActions = (
  session: SessionDto,
  viewer: Viewer | null,
): Omit<SessionControlDto, "toggleSharedControl"> => {
  if (viewer === null) return { own: false, steer: false, stop: false };
  const steer = canSteerSession(
    {
      ownerUserId: session.ownerUserId,
      sharedControlEnabledAt:
        session.sharedControlEnabledAt === null ? null : new Date(session.sharedControlEnabledAt),
    },
    viewer.userId,
  );
  return {
    own: session.ownerUserId !== null && session.ownerUserId === viewer.userId,
    steer,
    stop: steer || viewer.role === "owner",
  };
};

/** Nothing: what a pane offers before the server has said what the caller may do. */
export const NO_CONTROL: SessionControlDto = {
  own: false,
  steer: false,
  stop: false,
  toggleSharedControl: false,
};
