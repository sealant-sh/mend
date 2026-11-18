/**
 * Pure view logic for joining an organization from an invitation link
 * (docs/adr/0003-organizations-and-tenancy.md), so every decision the join page makes is testable.
 * Copied from the old app's `lib/organization.ts`, cut to what the join page uses.
 */

/** Why a link can't be used any more, as the invitation preview gives it. */
export type SpentState = "accepted" | "revoked" | "expired";

/** What the join page shows for one invitation link. */
export type JoinState =
  /** The link was used, revoked or expired. */
  | { readonly kind: "spent"; readonly state: SpentState }
  /** Nobody is signed in: create an account, or sign in, to accept. */
  | { readonly kind: "register" }
  /** Signed in with an account that isn't in the organization yet. */
  | { readonly kind: "join" }
  /** Signed in with an account that is in it already; `active` when this browser acts in it. */
  | { readonly kind: "member"; readonly active: boolean };

/**
 * `memberships` is null when nobody is signed in. An account that is in the organization already
 * reads as a member even when the link is spent, since that is most often the link it joined with.
 */
export const joinState = (
  invitation: {
    readonly state: "open" | SpentState;
    readonly organizationId: string;
  },
  memberships: ReadonlyArray<{
    readonly organization: { readonly id: string };
    readonly active: boolean;
  }> | null,
): JoinState => {
  const held = memberships?.find(
    (membership) => membership.organization.id === invitation.organizationId,
  );
  if (held !== undefined) return { kind: "member", active: held.active };
  if (invitation.state !== "open") return { kind: "spent", state: invitation.state };
  return memberships === null ? { kind: "register" } : { kind: "join" };
};

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const DAY_IN_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "20 November", with the year when it isn't this year's. */
export const dayOf = (date: Date, now: Date = new Date()): string =>
  (date.getFullYear() === now.getFullYear() ? DAY : DAY_IN_YEAR).format(date);

/** Why a spent link can't be used, as the sentence after "This invitation can't be used." */
export const spentReason = (state: SpentState, expiresAt: Date, now: Date = new Date()): string => {
  switch (state) {
    case "accepted":
      return "Someone already used it to join.";
    case "revoked":
      return "An owner revoked it.";
    case "expired":
      return `It expired on ${dayOf(expiresAt, now)} at ${TIME.format(expiresAt)}.`;
  }
};

/** Up to two initials from a person's name, or the first letter of their email without one. */
export const initialsOf = (name: string, email: string): string => {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "" && word !== email);
  const letters =
    words.length === 0
      ? [email.trim().charAt(0)]
      : [words[0]?.charAt(0), words.length > 1 ? words.at(-1)?.charAt(0) : undefined];
  return letters
    .filter((letter) => letter !== undefined)
    .join("")
    .toUpperCase();
};
