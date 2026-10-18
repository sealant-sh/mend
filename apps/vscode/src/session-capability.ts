import { canSteerSession } from "@mend/domain/workbench";

import type { MemberName } from "./session-lines.js";
import type { Session } from "./types.js";

/**
 * What a session row offers its viewer. Remote-SSH admits only the person who launched the
 * workspace (docs/adr/0016), so for anyone else Open would end in "Permission denied": their row
 * offers Review, and Watch terminal where the server lets them in.
 */
export type RowCapability =
  | { readonly kind: "open" }
  | { readonly kind: "notYours"; readonly watch: boolean; readonly why: string };

export const rowCapability = (facts: {
  readonly session: Pick<
    Session,
    "ownerUserId" | "sharedControlEnabledAt" | "workspaceLauncherUserId" | "livePeople"
  >;
  readonly viewer: string | null;
  readonly members: ReadonlyArray<MemberName>;
}): RowCapability => {
  const { session, viewer, members } = facts;
  const launcher = session.workspaceLauncherUserId;
  if (launcher === null || viewer === null || launcher === viewer) return { kind: "open" };
  const name =
    members.find((member) => member.userId === launcher)?.name ??
    session.livePeople.find((person) => person.accountId === launcher)?.name ??
    "another person";
  return {
    kind: "notYours",
    watch: canSteerSession(
      {
        ownerUserId: session.ownerUserId,
        sharedControlEnabledAt:
          session.sharedControlEnabledAt === null ? null : new Date(session.sharedControlEnabledAt),
      },
      viewer,
    ),
    why: `${name} launched this workspace · Remote-SSH opens it only for them`,
  };
};

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** The row's `viewItem`: the manifest's menus key on it. */
export const rowContextValue = (
  session: Pick<Session, "status">,
  capability: RowCapability,
): string => {
  const phase = LIVE_STATUSES.has(session.status) ? "live" : "settled";
  const offer = capability.kind === "open" ? "open" : capability.watch ? "watch" : "review";
  return `mend.session.${phase}.${offer}`;
};
