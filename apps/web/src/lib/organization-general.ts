/**
 * Settings → the organization → General (route PR 45, Doop "Settings · Northwind · General"): the
 * organization's name, who owns it, and leaving it. Pure, so each sentence the page shows is
 * tested without a server.
 */

import { organizationNameIssue } from "@mend/domain/workbench";

import { dayOf } from "./organization.ts";
import { refusalTagOf } from "./refusal.ts";

/** One person on the organization's roster, as the page reads them. */
export interface RosterMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "member";
  readonly joinedAt: Date;
}

/** The organization's owners, the person looking first, then by name. */
export const ownersOf = (
  roster: ReadonlyArray<RosterMember>,
  viewerId: string,
): ReadonlyArray<RosterMember> =>
  roster
    .filter((member) => member.role === "owner")
    .toSorted((a, b) =>
      a.userId === viewerId ? -1 : b.userId === viewerId ? 1 : a.name.localeCompare(b.name),
    );

/** "Ada Lovelace", "Ada Lovelace and Mae Jemison", "Ada, Mae and Grace". */
export const namesList = (names: ReadonlyArray<string>): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
};

/**
 * When an owner joined, beside their name. The server keeps when someone joined, not when they
 * became an owner, so the page says the first ("Joined 2 March"), never "Owner since".
 */
export const joinedLine = (joinedAt: Date, now: Date = new Date()): string =>
  joinedAt.toDateString() === now.toDateString()
    ? "Joined today"
    : `Joined ${dayOf(joinedAt, now)}`;

/** Who may rename the organization, for a member who can't: the owners, by name. */
export const whoRenames = (organization: string, owners: ReadonlyArray<string>): string =>
  owners.length === 0
    ? `Only an owner of ${organization} can rename it.`
    : `Only an owner can rename it: ${namesList(owners)}.`;

/** The name field's state: what the person typed against the saved name. */
export interface NameDraft {
  /** Whether Save and Discard show. */
  readonly changed: boolean;
  /** Why Mend won't send it, beside the field; null when it may be sent. */
  readonly problem: string | null;
}

/** Whether a typed name differs from the saved one, and what the name rules say about it. */
export const nameDraft = (saved: string, typed: string): NameDraft => {
  const changed = typed.trim() !== saved;
  return { changed, problem: changed ? (organizationNameIssue(typed)?.message ?? null) : null };
};

/** The refusals about the name itself: their words go beside the Name field. */
const NAME_REFUSALS: ReadonlySet<string> = new Set([
  "OrganizationNameEmpty",
  "OrganizationNameNotAllowed",
  "OrganizationNameTaken",
]);

/**
 * What a refused rename says, beside the field. A refusal about the name is the server's own
 * sentence; anything else says the name wasn't saved and why.
 */
export const renameRefusal = (cause: unknown, organization: string): string => {
  const tag = refusalTagOf(cause);
  const message = cause instanceof Error && cause.message !== "" ? cause.message : null;
  if (tag !== null && NAME_REFUSALS.has(tag) && message !== null) return message;
  if (tag === "NotFound") return `Only an owner of ${organization} can rename it.`;
  return `Mend didn't rename ${organization}. ${message ?? "Check your connection and try again."}`;
};

/** What the Leave row shows: a note under its description, and whether it offers Leave. */
export interface LeaveRow {
  readonly note: string | null;
  readonly offer: boolean;
}

/**
 * The server refuses leaving your only organization and leaving as its last owner. The row says
 * which before the person tries: with no other organization it offers nothing; as the only owner
 * it still opens the Leave dialog, which says what to do first.
 */
export const leaveRow = ({
  organization,
  viewerId,
  roster,
  organizations,
}: {
  readonly organization: string;
  readonly viewerId: string;
  readonly roster: ReadonlyArray<RosterMember>;
  /** How many organizations the person belongs to on this server. */
  readonly organizations: number;
}): LeaveRow => {
  if (organizations <= 1) {
    return {
      note: `${organization} is your only organization on this server, so you can't leave it. An owner can remove you instead.`,
      offer: false,
    };
  }
  const me = roster.find((member) => member.userId === viewerId);
  if (me?.role !== "owner") return { note: null, offer: true };
  const others = roster.filter((member) => member.role === "owner" && member.userId !== viewerId);
  const [only] = others;
  if (only === undefined) {
    return {
      note: `You're ${organization}'s only owner. Make someone else an owner on the Members page before you leave.`,
      offer: true,
    };
  }
  return {
    note:
      others.length === 1
        ? `${only.name} is also an owner, so you can leave. If you were the only owner, you'd need to make someone else an owner first.`
        : `${organization} has ${others.length} other owners, so you can leave.`,
    offer: true,
  };
};
