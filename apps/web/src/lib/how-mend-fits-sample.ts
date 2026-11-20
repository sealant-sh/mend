import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";

import type { SessionInboxRowDto } from "./api.ts";
import { SAMPLE_SESSION } from "./how-mend-fits.ts";
import {
  DEFAULT_INBOX_FILTERS,
  groupRows,
  type InboxMark,
  inboxRows,
  matchesFilters,
} from "./inbox.ts";
import type { InboxView } from "./use-inbox.ts";

/**
 * The sample sessions How Mend fits together's sidebar pictures list. Only the pictures read them,
 * and they load with the pictures, not with the app's first page.
 */

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
