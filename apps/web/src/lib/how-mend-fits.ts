import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";

import type { SessionInboxRowDto } from "./api.ts";
import {
  DEFAULT_INBOX_FILTERS,
  groupRows,
  type InboxMark,
  inboxRows,
  matchesFilters,
} from "./inbox.ts";
import type { InboxView } from "./use-inbox.ts";

/**
 * How Mend fits together (SLNT-1203; Doop page "1 · Onboarding · How Mend fits together"): setup's
 * last step, and the same three screens opened again from the account menu. The words that depend
 * on who is reading, and the sample sessions the pictures show. The pictures are the app's own
 * components drawn with these samples, so they change when the components do.
 */

/** The step's three screens: how the parts nest, inside a session, the sidebar. */
export type FitsScreen = 1 | 2 | 3;

export const FITS_SCREENS: ReadonlyArray<FitsScreen> = [1, 2, 3];

/** The screen an address asks for (`?screen=2`); the first for anything else. */
export const screenOf = (value: unknown): FitsScreen => {
  const number = typeof value === "string" ? Number(value) : value;
  return number === 2 || number === 3 ? number : 1;
};

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

/** The sample reader's id: the sample sessions are theirs, so "Mine" lists them all. */
const SAMPLE_VIEWER = "sample-viewer";

const minutesBefore = (now: Date, minutes: number): Date =>
  new Date(now.getTime() - minutes * 60_000);

interface SampleSession {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly status: SessionInboxRowDto["session"]["status"];
  readonly minutes: number;
  readonly files?: number;
  readonly ask?: SessionInboxRowDto["ask"];
  readonly activity?: SessionInboxRowDto["activity"];
}

const sampleRow = (session: SampleSession, now: Date): SessionInboxRowDto => {
  const updatedAt = minutesBefore(now, session.minutes);
  return {
    session: {
      id: SessionId.make(`sample-${session.id}`),
      projectId: ProjectId.make(`sample-${session.project}`),
      worktreeId: WorktreeId.make(`sample-wt-${session.id}`),
      harness: "claude",
      label: null,
      branch: `mend/${session.id}`,
      status: session.status,
      ownerUserId: SAMPLE_VIEWER,
      sharedControlEnabledAt: null,
      sharedControlUserIds: [],
      startedAt: minutesBefore(now, session.minutes + 20),
      settledAt: null,
      createdAt: minutesBefore(now, session.minutes + 20),
      updatedAt,
      importedConversationWaiting: false,
    },
    projectName: session.project,
    title: session.title,
    annotation:
      session.files === undefined
        ? null
        : {
            changeId: ChangeId.make(`sample-change-${session.id}`),
            totalComments: 0,
            pendingFollowUp: false,
            liveServices: 0,
            currentAgent: null,
            fileCount: session.files,
          },
    ask: session.ask ?? null,
    worktreeName: null,
    failure: null,
    activity: session.activity ?? null,
  };
};

/**
 * The sample sessions the sidebar picture lists (Doop frame "The sidebar"): two waiting on you in
 * the reader's project and in `infra`, two to review in `web`, two running, one snoozed and nine
 * done. Their groups come from the inbox's own rules (`inboxRows`), so the picture shows whatever
 * the sidebar would.
 */
export const sampleSessions = (
  project: string,
  now: Date,
): {
  readonly rows: ReadonlyArray<SessionInboxRowDto>;
  readonly marks: ReadonlyArray<InboxMark>;
} => {
  const sessions: ReadonlyArray<SampleSession> = [
    {
      id: "retry",
      title: SAMPLE_SESSION,
      project,
      status: "waiting",
      minutes: 4,
      ask: { kind: "question", subject: "Should we back off on a 409 too?" },
    },
    {
      id: "rotate",
      title: "Rotate staging database credentials",
      project: "infra",
      status: "waiting",
      minutes: 11,
      ask: { kind: "command", subject: "terraform apply" },
    },
    {
      id: "router",
      title: "Upgrade to React Router 8",
      project: "web",
      status: "failed",
      minutes: 22,
      files: 6,
    },
    {
      id: "currency",
      title: "Show prices in the shopper's currency",
      project: "web",
      status: "completed",
      minutes: 60,
      files: 4,
    },
    {
      id: "regression",
      title: "Add a regression test for 409s",
      project,
      status: "running",
      minutes: 1,
      activity: { kind: "edit", subject: null },
    },
    { id: "sdk", title: "Bump the payments SDK", project, status: "running", minutes: 3 },
    {
      id: "flags",
      title: "Clean up old feature flags",
      project: "web",
      status: "completed",
      minutes: 90,
    },
    ...Array.from(
      { length: 9 },
      (_, index): SampleSession => ({
        id: `done-${index}`,
        title: `Answer a question about ${["the cache", "retries", "the schema", "logging", "auth", "the queue", "billing", "tests", "deploys"][index] ?? "the code"}`,
        project: index % 2 === 0 ? project : "web",
        status: "completed",
        minutes: 120 + index * 60,
        files: 0,
      }),
    ),
  ];
  return {
    rows: sessions.map((session) => sampleRow(session, now)),
    marks: [
      {
        sessionId: "sample-flags",
        state: "snoozed",
        snoozedUntil: new Date(now.getTime() + 3 * 3_600_000),
        markedAt: minutesBefore(now, 80),
      },
    ],
  };
};

/** The sample sessions as the sidebar and the phone inbox read them, with every project shown. */
export const sampleInboxView = (project: string, now: Date): InboxView => {
  const { rows, marks } = sampleSessions(project, now);
  const all = inboxRows({ rows, marks, now });
  return {
    groups: groupRows(
      all.filter((row) => matchesFilters(row, DEFAULT_INBOX_FILTERS, SAMPLE_VIEWER)),
    ),
    queued: { running: [], review: [] },
    all,
    empty: false,
    readAt: now,
    filters: DEFAULT_INBOX_FILTERS,
    now,
    viewerId: SAMPLE_VIEWER,
    refresh: () => {},
  };
};
