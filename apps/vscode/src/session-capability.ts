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

/**
 * The one thing a gesture at the session does for this viewer, wherever it comes from (the row,
 * the palette, the status bar's pick, a deep link): Open, or what helps instead.
 */
export type RowOffer = "Open" | "Watch terminal" | "Review";

export type NotYoursOffer = Exclude<RowOffer, "Open">;

export const notYoursOffer = (
  capability: Extract<RowCapability, { readonly kind: "notYours" }>,
): NotYoursOffer => (capability.watch ? "Watch terminal" : "Review");

export const rowOffer = (capability: RowCapability): RowOffer =>
  capability.kind === "open" ? "Open" : notYoursOffer(capability);

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

const OFFER_KEYS: Readonly<Record<RowOffer, string>> = {
  Open: "open",
  "Watch terminal": "watch",
  Review: "review",
};

/** The row's `viewItem`: the manifest's menus key on it. */
export const rowContextValue = (
  session: Pick<Session, "status">,
  capability: RowCapability,
): string => {
  const phase = LIVE_STATUSES.has(session.status) ? "live" : "settled";
  return `mend.session.${phase}.${OFFER_KEYS[rowOffer(capability)]}`;
};

/** A session picker's words beside a name: its status, and what picking it does when not Open. */
export const pickDescription = (
  session: Pick<Session, "status">,
  capability: RowCapability,
): string => {
  const offer = rowOffer(capability);
  return offer === "Open" ? session.status : `${session.status} · ${offer}`;
};
