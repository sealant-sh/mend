import { canSteerSession } from "@mend/domain/workbench";

import type { MemberName } from "./session-lines.js";
import type { Session } from "./types.js";

/**
 * What a session row offers its viewer. Remote-SSH admits only the person who launched the
 * workspace (docs/adr/0016), so for anyone else Open would end in "Permission denied": their row
 * offers Review, and Watch terminal where the server lets them in. When Mend could not read who
 * the viewer is, the row offers only what is safe for anyone, and an Open decides on a fresh read.
 */
export type RowCapability =
  | { readonly kind: "open" }
  | { readonly kind: "notYours"; readonly watch: boolean; readonly why: string }
  | { readonly kind: "unknown"; readonly why: string };

type SteeringFacts = Pick<Session, "ownerUserId" | "sharedControlEnabledAt">;

/** Whether the server lets `viewer` steer, and so attach to the terminal of, `session`. */
export const maySteer = (session: SteeringFacts, viewer: string): boolean =>
  canSteerSession(
    {
      ownerUserId: session.ownerUserId,
      sharedControlEnabledAt:
        session.sharedControlEnabledAt === null ? null : new Date(session.sharedControlEnabledAt),
    },
    viewer,
  );

/** Whether the viewer may steer (and so stop) the session; false when Mend could not say who she is. */
export const mayStop = (session: SteeringFacts, viewer: string | null): boolean =>
  viewer !== null && maySteer(session, viewer);

/** Whether `viewer` types in the session's terminals: its owner, or anyone when Mend cannot say. */
export const ownsSession = (
  session: Pick<Session, "ownerUserId">,
  viewer: string | null,
): boolean => viewer === null || session.ownerUserId === null || viewer === session.ownerUserId;

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
  if (launcher === null || launcher === viewer) return { kind: "open" };
  // A launcher is listed, so the viewer was asked for: her identity read failed.
  if (viewer === null) {
    return { kind: "unknown", why: "Mend could not read who you are on this server" };
  }
  const name =
    members.find((member) => member.userId === launcher)?.name ??
    session.livePeople.find((person) => person.accountId === launcher)?.name ??
    "another person";
  return {
    kind: "notYours",
    watch: maySteer(session, viewer),
    why: `${name} launched this workspace · Remote-SSH opens it only for them`,
  };
};

/**
 * The one thing a gesture at the session does for this viewer, wherever it comes from (the row,
 * the palette, the status bar's pick, a deep link): Open, or what helps instead.
 */
export type RowOffer = "Open" | "Watch terminal" | "Review";

export type NotYoursOffer = Exclude<RowOffer, "Open">;

export const notYoursOffer = (
  capability: Exclude<RowCapability, { readonly kind: "open" }>,
): NotYoursOffer =>
  capability.kind === "notYours" && capability.watch ? "Watch terminal" : "Review";

export const rowOffer = (capability: RowCapability): RowOffer =>
  capability.kind === "open" ? "Open" : notYoursOffer(capability);

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

const OFFER_KEYS: Readonly<Record<RowOffer, string>> = {
  Open: "open",
  "Watch terminal": "watch",
  Review: "review",
};

/**
 * The row's `viewItem`, `mend.session.<phase>.<offer>[.steer]`: the manifest's menus key on it.
 * `.steer` marks a session the viewer may steer, the only ones Stop is offered on.
 */
export const rowContextValue = (
  session: Pick<Session, "status">,
  capability: RowCapability,
  steer: boolean,
): string => {
  const phase = LIVE_STATUSES.has(session.status) ? "live" : "settled";
  return `mend.session.${phase}.${OFFER_KEYS[rowOffer(capability)]}${steer ? ".steer" : ""}`;
};

/** A session picker's words beside a name: its status, and what picking it does when not Open. */
export const pickDescription = (
  session: Pick<Session, "status">,
  capability: RowCapability,
): string => {
  const offer = rowOffer(capability);
  return offer === "Open" ? session.status : `${session.status} · ${offer}`;
};
