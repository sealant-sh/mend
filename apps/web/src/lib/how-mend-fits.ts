import type { FitsScreen } from "./how-mend-fits-screen.ts";

/**
 * How Mend fits together (SLNT-1203; Doop page "1 · Onboarding · How Mend fits together"): setup's
 * last step, and the same three screens opened again from the account menu. The words that depend
 * on who is reading. The sample sessions the pictures show are in `how-mend-fits-sample.ts`.
 */

/** What the screens name, from who is reading. */
export interface FitsNames {
  /** This server's address, as the browser reached it. */
  readonly host: string;
  readonly organization: string;
  /** Whether the reader owns the organization (and so invites its members). */
  readonly owner: boolean;
  /** The reader's name, for the account row in the sidebar picture. */
  readonly person: string;
  readonly email: string;
  /** The project the pictures show: the reader's own, or the sample `checkout-api`. */
  readonly project: string;
  /** Whether `project` is the reader's own: one they just added, or can see. */
  readonly ownProject: boolean;
}

/** The project the pictures use when the reader has none of their own. */
export const SAMPLE_PROJECT = "checkout-api";

/** The worktree and branch the pictures show. */
export const SAMPLE_WORKTREE = "fix-checkout-retry";
export const SAMPLE_BRANCH = "mend/fix-checkout-retry";

/** Each screen's heading. On a phone the sidebar is the inbox. */
export const screenTitle = (screen: FitsScreen, phone: boolean): string =>
  screen === 1
    ? "How Mend fits together"
    : screen === 2
      ? "Inside a session"
      : phone
        ? "The inbox"
        : "The sidebar";

/**
 * The project the pictures show: the clone this browser just started, else the newest project the
 * reader can see, else the sample.
 */
export const pictureProject = (
  cloning: string | null,
  projects: ReadonlyArray<{ readonly name: string; readonly createdAt: Date }>,
): { readonly name: string; readonly own: boolean } => {
  if (cloning !== null && cloning !== "") return { name: cloning, own: true };
  const newest = projects.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return newest === undefined
    ? { name: SAMPLE_PROJECT, own: false }
    : { name: newest.name, own: true };
};

/** The first screen's opening line. */
export const nestingIntro = ({ project, ownProject }: FitsNames): string =>
  ownProject
    ? `Each part of Mend sits inside the one above it. Here they are, shown with ${project}, the project you just added.`
    : `Each part of Mend sits inside the one above it. Here they are, shown with a sample project, ${project}.`;

/** What an organization is, said to its owner or to a member. */
export const organizationLine = ({ organization, owner }: FitsNames): string =>
  owner
    ? `The people who share this server's projects. You're ${organization}'s owner, so you invite its members.`
    : `The people who share this server's projects. You're a member of ${organization}. Its owners invite people.`;

/** Under the first screen's pictures. */
export const nestingCaption = ({ project }: FitsNames): string =>
  `Pictures from ${project}'s Worktrees tab, and from the Details and Change tabs of one of its sessions.`;

/** The session the second screen shows. */
export const SAMPLE_SESSION = "Fix flaky checkout retry";

/** Under the second screen's picture. */
export const sessionCaption = ({ project }: FitsNames): string =>
  `The session ${SAMPLE_SESSION}, in the ${SAMPLE_WORKTREE} worktree of ${project}.`;

/** The third screen's opening line: the sidebar on a computer, the inbox on a phone. */
export const sidebarIntro = ({ organization }: FitsNames, phone: boolean): string =>
  phone
    ? "The inbox lists your sessions in five groups, so you can see which ones need you."
    : `The sidebar is on the left of every page. It lists your sessions in ${organization} in five groups, so you can see which ones need you.`;

/** Under the third screen's picture. */
export const sidebarCaption = (
  { organization, person, project }: FitsNames,
  phone: boolean,
): string =>
  phone
    ? `${person}'s inbox in ${organization}, on the phone.`
    : `${person}'s sidebar in ${organization}, from ${project}'s project page.`;

/** The five groups, in the sidebar's order, in the owner's words (20 Nov 2026). */
export const GROUP_WORDS: ReadonlyArray<{ readonly name: string; readonly words: string }> = [
  { name: "Waiting on you", words: "The agent asked you something." },
  { name: "To review", words: "Ended with changed files." },
  { name: "Running", words: "From start until the session ends." },
  { name: "Snoozed", words: "Put off until a time." },
  { name: "Done", words: "Ended without changed files, or marked done." },
];
