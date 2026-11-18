/**
 * Creating an organization and leaving one (docs/adr/0003, "Organization switching"): what the
 * Create organization dialog does with a refused name, and what the Leave dialog tells a person
 * before they go. Pure, so each decision is testable without a server.
 */

import { refusalTagOf } from "./refusal.ts";

/** The refusals about the name itself: their words go beside the Name field. */
const NAME_REFUSALS: ReadonlySet<string> = new Set([
  "OrganizationNameEmpty",
  "OrganizationNameNotAllowed",
  "OrganizationNameTaken",
]);

/** Whether a refused create was about the name, so the dialog shows it beside the field. */
export const refusedName = (cause: unknown): boolean => {
  const tag = refusalTagOf(cause);
  return tag !== null && NAME_REFUSALS.has(tag);
};

/** A session that still runs something Mend stops when its owner leaves the organization. */
const LIVE: ReadonlySet<string> = new Set(["starting", "running", "stopping", "waiting", "idle"]);

/** How many of the person's own sessions are live in the organization's inbox read. */
export const liveSessionsOf = (
  sessions: ReadonlyArray<{ readonly ownerUserId: string | null; readonly status: string }>,
  userId: string,
): number =>
  sessions.filter((session) => session.ownerUserId === userId && LIVE.has(session.status)).length;

/** What the Leave dialog shows: the reason the only owner can't go, or what leaving does. */
export type LeavePlan =
  | { readonly kind: "only-owner" }
  | {
      readonly kind: "leave";
      /** What the person loses, one sentence each. */
      readonly losses: ReadonlyArray<string>;
      /** Where this browser goes once they've left. */
      readonly destination: string;
    };

export interface LeaveInput {
  readonly organization: string;
  readonly viewerId: string;
  /** The organization's roster; null while it hasn't been read. */
  readonly roster: ReadonlyArray<{
    readonly userId: string;
    readonly name: string;
    readonly role: "owner" | "member";
  }> | null;
  /** The names of the person's other organizations. */
  readonly others: ReadonlyArray<string>;
  /** How many of their sessions in it are live; null while the inbox hasn't been read. */
  readonly liveSessions: number | null;
}

const sessionsLine = (organization: string, live: number | null): string | null => {
  if (live === null)
    return `Mend stops any session you have running in ${organization}. Its work so far is kept.`;
  if (live === 0) return null;
  if (live === 1) return `Your running session in ${organization} stops. Its work so far is kept.`;
  return `Your ${live} running sessions in ${organization} stop. Their work so far is kept.`;
};

/**
 * The server refuses the last owner (`LastOwnerError`); the dialog says so before they try. With
 * the roster not read yet, the dialog offers Leave and shows the server's refusal if it comes.
 * The server picks where the sign-in goes: the organization chosen most recently before this one.
 */
export const leavePlan = ({
  organization,
  viewerId,
  roster,
  others,
  liveSessions,
}: LeaveInput): LeavePlan => {
  const me = roster?.find((member) => member.userId === viewerId);
  const otherOwners = (roster ?? []).filter(
    (member) => member.role === "owner" && member.userId !== viewerId,
  );
  if (me?.role === "owner" && otherOwners.length === 0) return { kind: "only-owner" };
  const owners =
    me?.role !== "owner"
      ? null
      : otherOwners.length === 1
        ? `${otherOwners[0]?.name ?? "Another owner"} stays as ${organization}'s owner.`
        : `${organization}'s other ${otherOwners.length} owners stay.`;
  const losses = [
    sessionsLine(organization, liveSessions),
    `Your access keys for ${organization} stop working.`,
    `Projects only you can see stay in ${organization}, and its owners can take them over.`,
    owners,
  ].filter((line) => line !== null);
  const [only] = others;
  return {
    kind: "leave",
    losses,
    destination:
      others.length === 1 && only !== undefined
        ? `You'll go to ${only}, your other organization.`
        : `You'll go to the organization you used before ${organization}.`,
  };
};
