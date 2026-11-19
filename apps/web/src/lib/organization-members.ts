/**
 * Settings → the organization → Members (route PR 46, Doop page 6 "Invite someone", "Linus joins",
 * "Change a role", "Remove a member"): the roster, invitations, and what each owner action says
 * before and after. Pure, so each sentence and each rule is tested without a server.
 *
 * The server decides who may do what (an organization keeps at least one owner; owners reset only
 * members' passwords; members get 404 for owner actions). The page says the same rules before the
 * person tries, and shows the server's own refusal beside the control when one still comes.
 */

import {
  INVITATION_DEFAULT_DAYS,
  INVITATION_MAX_DAYS,
  invitationState,
} from "@mend/domain/workbench";

import { dayOf } from "./organization.ts";
import { refusalTagOf } from "./refusal.ts";

export type Role = "owner" | "member";

/** One person on the roster, as the page reads them. */
export interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: Date;
}

/** One invitation, as the page reads it. */
export interface InvitationRow {
  readonly id: string;
  readonly role: Role;
  readonly email: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedByUserId: string | null;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const SHORT_IN_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** "Today, 11:20", "2 Mar", "24 Dec 2025": a short day, with the time only for today. */
export const shortDay = (date: Date, now: Date = new Date()): string => {
  if (sameDay(date, now)) return `Today, ${TIME.format(date)}`;
  return (date.getFullYear() === now.getFullYear() ? SHORT : SHORT_IN_YEAR).format(date);
};

/** The roster in the page's order: the person looking first, then by when each joined. */
export const rosterOrder = (
  roster: ReadonlyArray<Member>,
  viewerId: string,
): ReadonlyArray<Member> =>
  roster.toSorted((a, b) => {
    if (a.userId === viewerId) return -1;
    if (b.userId === viewerId) return 1;
    return a.joinedAt.getTime() - b.joinedAt.getTime() || a.name.localeCompare(b.name);
  });

/** Joined in the last day: the row says "New". */
export const isNew = (member: Member, now: Date = new Date()): boolean =>
  now.getTime() - member.joinedAt.getTime() < DAY_MS;

/** The organization's owners. */
const ownersOf = (roster: ReadonlyArray<Member>): ReadonlyArray<Member> =>
  roster.filter((member) => member.role === "owner");

/** Whether this person is the organization's only owner: their role is locked. */
export const isOnlyOwner = (roster: ReadonlyArray<Member>, userId: string): boolean => {
  const owners = ownersOf(roster);
  return owners.length === 1 && owners[0]?.userId === userId;
};

/** "Dorothy" from "Dorothy Vaughan"; the email's name for an account without one. */
export const firstNameOf = (member: Pick<Member, "name" | "email">): string =>
  member.name.trim().split(/\s+/)[0] || member.email.split("@")[0] || member.email;

/** The words beside each role in the role menu (Doop "Change a role"). */
export const roleHint = (role: Role, organization: string): string =>
  role === "owner" ? `Also manages ${organization}` : "Uses projects";

export const roleWord = (role: Role): string => (role === "owner" ? "Owner" : "Member");

/** The toast after a role change. */
export const roleChanged = (member: Pick<Member, "name">, role: Role, organization: string) =>
  role === "owner"
    ? `${member.name} is now an owner of ${organization}.`
    : `${member.name} is now a member of ${organization}.`;

/**
 * What a member's password reset offers. The server resets members only: an owner's and the
 * operator's go through the operator of this server, so for an owner the item says so instead.
 */
export const resetOffer = (
  member: Pick<Member, "role">,
  you: boolean,
): { readonly offer: true } | { readonly offer: false; readonly why: string } => {
  if (you) return { offer: false, why: "Change your own password in Profile." };
  if (member.role === "owner")
    return { offer: false, why: "Owners reset their password through this server's operator." };
  return { offer: true };
};

/**
 * Why an owner action was refused, in words for the place it happened. The server's own sentence
 * is used when it sends one (the last-owner rule, an operator's account); a 404 means the person
 * is no longer in the organization, or the viewer is no longer an owner.
 */
export const refusalWords = (cause: unknown, fallback: string): string => {
  const tag = refusalTagOf(cause);
  if (tag === "NotFound")
    return "Mend couldn't find that person in the organization any more, or you're no longer an owner. Reload the page to see where things stand.";
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message === "" ? fallback : message;
};

/** The sessions of the person being removed that Mend stops, said in the Remove dialog. */
export interface RemovalSessions {
  /** How many of their sessions the viewer can see in the inbox; null when it wasn't read. */
  readonly total: number | null;
  /** The titles of the ones still running. */
  readonly running: ReadonlyArray<string>;
}

/** The Remove dialog's paragraphs (Doop "Remove a member"). */
export const removalLines = (
  member: Pick<Member, "name" | "email">,
  organization: string,
  sessions: RemovalSessions,
): { readonly access: string; readonly sessions: string | null; readonly again: string } => {
  const first = firstNameOf(member);
  const access = `${first} won't be able to open ${organization}'s projects or sessions, and Mend signs ${first}'s devices out of ${organization} straight away.`;
  const again = `To add ${first} again, create a new invitation.`;
  const { total, running } = sessions;
  const stops =
    running.length === 0
      ? ""
      : running.length === 1
        ? ` Mend stops the one that's running, ${running[0]}.`
        : ` Mend stops the ${running.length} that are running.`;
  if (total === null)
    return {
      access,
      sessions: `${first}'s sessions stay in their projects, and Mend stops any that are running.`,
      again,
    };
  if (total === 0) return { access, sessions: null, again };
  return {
    access,
    sessions: `${first}'s ${total === 1 ? "session stays" : `${total} sessions stay`} in their projects. Owners can still open them and review their changes.${stops}`,
    again,
  };
};

/** The toast after a removal, and what Mend still owes (an SSH key the platform kept). */
export const removedToast = (
  member: Pick<Member, "name" | "email">,
  organization: string,
  stopped: number,
  outcome: { readonly sshKeysOutstanding: number | null },
): string => {
  const first = firstNameOf(member);
  const stoppedWords =
    stopped === 0
      ? ""
      : stopped === 1
        ? ` and stopped ${first}'s running session`
        : ` and stopped ${first}'s ${stopped} running sessions`;
  const keys =
    outcome.sshKeysOutstanding === null || outcome.sshKeysOutstanding === 0
      ? ""
      : ` Mend is still removing ${outcome.sshKeysOutstanding === 1 ? "one of their workspace SSH keys" : `${outcome.sshKeysOutstanding} of their workspace SSH keys`} and keeps trying until it's gone.`;
  return `Removed ${member.name} from ${organization}${stoppedWords}.${keys}`;
};

/** Open invitations, and the rest (used, expired or revoked), newest first. */
export const invitationGroups = (
  invitations: ReadonlyArray<InvitationRow>,
  now: Date = new Date(),
): {
  readonly open: ReadonlyArray<InvitationRow>;
  readonly closed: ReadonlyArray<InvitationRow>;
} => {
  const newest = invitations.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    open: newest.filter((invitation) => invitationState(invitation, now) === "open"),
    closed: newest.filter((invitation) => invitationState(invitation, now) !== "open"),
  };
};

/** Who a link is for: its bound email, or anyone who holds it. */
export const sentTo = (invitation: Pick<InvitationRow, "email">): string =>
  invitation.email ?? "Anyone with the link";

/** "By you · today, 11:12", "By Grace Hopper · 21 Nov", "By a removed account · 2 Mar". */
export const createdLine = (
  invitation: Pick<InvitationRow, "createdByUserId" | "createdAt">,
  viewerId: string,
  roster: ReadonlyArray<Pick<Member, "userId" | "name">>,
  now: Date = new Date(),
): string => {
  const by =
    invitation.createdByUserId === viewerId
      ? "you"
      : (roster.find((member) => member.userId === invitation.createdByUserId)?.name ??
        "someone no longer here");
  const when = sameDay(invitation.createdAt, now)
    ? `today, ${TIME.format(invitation.createdAt)}`
    : shortDay(invitation.createdAt, now);
  return `By ${by} · ${when}`;
};

/** What became of a closed link, for the fold's list. */
export const closedState = (
  invitation: InvitationRow,
  roster: ReadonlyArray<Pick<Member, "userId" | "name">>,
  now: Date = new Date(),
): string => {
  switch (invitationState(invitation, now)) {
    case "accepted": {
      const who = roster.find((member) => member.userId === invitation.acceptedByUserId)?.name;
      const when = invitation.acceptedAt === null ? "" : ` on ${dayOf(invitation.acceptedAt, now)}`;
      return who === undefined ? `Used${when}` : `Used by ${who}${when}`;
    }
    case "revoked":
      return invitation.revokedAt === null
        ? "Revoked"
        : `Revoked on ${dayOf(invitation.revokedAt, now)}`;
    case "expired":
      return `Expired on ${dayOf(invitation.expiresAt, now)}`;
    case "open":
      return "Open";
  }
};

/** "Show 6 used, expired or revoked links". */
export const closedFold = (count: number): string =>
  count === 1
    ? "Show 1 used, expired or revoked link"
    : `Show ${count} used, expired or revoked links`;

/** The empty line under Invitations: after a revoke it says which link stopped working. */
export const noOpenInvitations = (revoked: { readonly email: string | null } | null): string => {
  if (revoked === null)
    return "No open invitations. Links you create show here until someone uses them or they expire.";
  return revoked.email === null
    ? "No open invitations. The link you revoked no longer works."
    : `No open invitations. The link you sent to ${revoked.email} no longer works.`;
};

/** The choices for how long a link lasts, up to the server's maximum. */
export const EXPIRY_DAYS: ReadonlyArray<number> = [
  1,
  3,
  INVITATION_DEFAULT_DAYS,
  14,
  INVITATION_MAX_DAYS,
];
export const DEFAULT_EXPIRY_DAYS = INVITATION_DEFAULT_DAYS;
export const MAX_EXPIRY_DAYS = INVITATION_MAX_DAYS;
export const expiryLabel = (days: number): string => (days === 1 ? "1 day" : `${days} days`);

/** A plausible address, or why it isn't one; empty is allowed (anyone with the link). */
export const emailProblem = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^[^\s@]+@[^\s@]+$/.test(trimmed) ? null : "That doesn't look like an email address.";
};

/** A link the server handed back, made whole with this page's origin. */
export const linkOf = (path: string, origin: string): string =>
  `${origin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

/** "22 Nov, 11:12, or once it's used". */
export const expiresLine = (expiresAt: Date, now: Date = new Date()): string =>
  `${sameDay(expiresAt, now) ? "Today" : shortDay(expiresAt, now)}, ${TIME.format(expiresAt)}, or once it's used`;

/** Who may use a new link. */
export const whoCanUse = (email: string | null): string =>
  email === null ? "Anyone who has the link" : `Only someone signing up as ${email}`;

/**
 * Someone joined with one of the viewer's own links since the page last read the list: the
 * invitation that went from open to accepted, and the new member it brought.
 */
export const joinedWithYours = (
  before: ReadonlyArray<InvitationRow>,
  after: ReadonlyArray<InvitationRow>,
  roster: ReadonlyArray<Member>,
  viewerId: string,
): ReadonlyArray<Member> => {
  const wasOpen = new Set(
    before
      .filter((invitation) => invitation.acceptedAt === null)
      .map((invitation) => invitation.id),
  );
  return after.flatMap((invitation) => {
    if (!wasOpen.has(invitation.id) || invitation.createdByUserId !== viewerId) return [];
    const joined = roster.find((member) => member.userId === invitation.acceptedByUserId);
    return joined === undefined ? [] : [joined];
  });
};

/** A session that still runs something, which Mend stops when its owner is removed. */
const LIVE: ReadonlySet<string> = new Set(["starting", "running", "stopping", "waiting", "idle"]);

/** The removed person's sessions the viewer can see, from the inbox read; null while unread. */
export const removalSessionsOf = (
  rows: ReadonlyArray<{
    readonly title: string;
    readonly session: { readonly ownerUserId: string | null; readonly status: string };
  }> | null,
  userId: string,
): RemovalSessions => {
  if (rows === null) return { total: null, running: [] };
  const theirs = rows.filter((row) => row.session.ownerUserId === userId);
  return {
    total: theirs.length,
    running: theirs.filter((row) => LIVE.has(row.session.status)).map((row) => row.title),
  };
};
