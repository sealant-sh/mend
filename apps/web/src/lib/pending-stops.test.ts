import { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { inboxRows } from "./inbox.ts";
import {
  acceptStop,
  beginStop,
  STOP_CATCH_UP_MS,
  stopPending,
  stoppedRow,
  undoStop,
} from "./pending-stops.ts";

const now = new Date("2026-11-20T12:00:00");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

type Status = SessionInboxRowDto["session"]["status"];

const row = (id: string, status: Status, files: number | null = null): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("web"),
    worktreeId: WorktreeId.make(`wt-${id}`),
    harness: "codex",
    label: null,
    branch: `mend/${id}`,
    status,
    ownerUserId: "ada",
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: minutesAgo(30),
    settledAt: null,
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(5),
    importedConversationWaiting: false,
  },
  projectName: "web",
  title: `Session ${id}`,
  annotation: {
    changeId: ChangeId.make(`change-${id}`),
    totalComments: 0,
    pendingFollowUp: false,
    liveServices: 0,
    currentAgent: null,
    fileCount: files,
  },
  ask: null,
  worktreeName: null,
  failure: null,
  activity: { kind: "edit", subject: "retry.ts" },
  turnOpen: true,
});

/** What a stop reads of a session's detail: its session and its agent (none launched here). */
const detail = (id: string, status: Status) => ({
  session: row(id, status).session,
  currentAgent: null,
});

/** The detail as these tests read it back. */
type DetailRead = ReturnType<typeof detail>;

const keys = {
  inbox: ["sessions", "inbox"],
  detail: (id: string) => ["sessions", "detail", id],
};

const cache = (rows: ReadonlyArray<SessionInboxRowDto>) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.inbox, rows);
  for (const each of rows)
    queryClient.setQueryData(
      keys.detail(each.session.id),
      detail(each.session.id, each.session.status),
    );
  return queryClient;
};

const statusOf = (queryClient: QueryClient, id: string) => ({
  row: queryClient
    .getQueryData<ReadonlyArray<SessionInboxRowDto>>(keys.inbox)
    ?.find((each) => each.session.id === id)?.session.status,
  detail: queryClient.getQueryData<DetailRead>(keys.detail(id))?.session.status,
});

/** What the server answers when a read lands: a new list, new objects, as an event or refetch. */
const serverSays = (queryClient: QueryClient, rows: ReadonlyArray<SessionInboxRowDto>) => {
  queryClient.setQueryData(keys.inbox, rows);
  for (const each of rows)
    queryClient.setQueryData(
      keys.detail(each.session.id),
      detail(each.session.id, each.session.status),
    );
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a stopped session's row, before the server says so", () => {
  it("goes where the inbox's own rules put an ended session: To review with files, Done without", () => {
    const rows = [
      stoppedRow(row("files", "running", 3), now),
      stoppedRow(row("none", "running", 0), now),
    ];
    const placed = inboxRows({ rows, marks: [], now, nameOf: () => null });
    expect(placed.map((each) => [each.session.id, each.group])).toEqual(
      expect.arrayContaining([
        ["files", "review"],
        ["none", "done"],
      ]),
    );
  });

  it("reads Stopped, with no turn or activity, and leaves a session that already ended alone", () => {
    const stopped = stoppedRow(row("s1", "running", 1), now);
    expect(stopped.session.status).toBe("stopped");
    expect(stopped.session.updatedAt).toBe(now);
    expect(stopped.turnOpen).toBe(false);
    expect(stopped.activity).toBeNull();
    const ended = row("s2", "completed");
    expect(stoppedRow(ended, now)).toBe(ended);
  });
});

describe("a stop on its way", () => {
  it("shows at once in the inbox and the session's detail, and nowhere else", () => {
    const queryClient = cache([row("s1", "running", 2), row("s2", "running")]);
    beginStop(queryClient, keys, "s1", now);
    expect(statusOf(queryClient, "s1")).toEqual({ row: "stopped", detail: "stopped" });
    expect(statusOf(queryClient, "s2")).toEqual({ row: "running", detail: "running" });
  });

  it("holds over reads that land before the server says the session ended", () => {
    const queryClient = cache([row("s1", "running", 2)]);
    beginStop(queryClient, keys, "s1", now);
    serverSays(queryClient, [row("s1", "running", 2)]);
    expect(statusOf(queryClient, "s1")).toEqual({ row: "stopped", detail: "stopped" });
    acceptStop(queryClient, "s1");
    // Saving the workspace before it stops: the server's word, not the person's.
    serverSays(queryClient, [row("s1", "stopping", 2)]);
    expect(statusOf(queryClient, "s1")).toEqual({ row: "stopped", detail: "stopped" });
    expect(stopPending(queryClient, "s1")).toBe(true);
  });

  it("ends once the server says the session ended, and its reads stand from then", () => {
    const queryClient = cache([row("s1", "running", 2)]);
    beginStop(queryClient, keys, "s1", now);
    acceptStop(queryClient, "s1");
    serverSays(queryClient, [row("s1", "stopped", 2)]);
    expect(stopPending(queryClient, "s1")).toBe(false);
    // A resumed session reads as the server says.
    serverSays(queryClient, [row("s1", "running", 2)]);
    expect(statusOf(queryClient, "s1")).toEqual({ row: "running", detail: "running" });
  });

  it("goes back to where it was when the stop fails", () => {
    const queryClient = cache([row("s1", "running", 2)]);
    const before = queryClient.getQueryData<ReadonlyArray<SessionInboxRowDto>>(keys.inbox)?.[0];
    beginStop(queryClient, keys, "s1", now);
    undoStop(queryClient, "s1");
    expect(stopPending(queryClient, "s1")).toBe(false);
    expect(queryClient.getQueryData<ReadonlyArray<SessionInboxRowDto>>(keys.inbox)?.[0]).toEqual(
      before,
    );
    expect(statusOf(queryClient, "s1")).toEqual({ row: "running", detail: "running" });
    serverSays(queryClient, [row("s1", "running", 2)]);
    expect(statusOf(queryClient, "s1")).toEqual({ row: "running", detail: "running" });
  });

  it("lets go of a stop the server took but never caught up with", () => {
    vi.useFakeTimers();
    const queryClient = cache([row("s1", "running", 2)]);
    beginStop(queryClient, keys, "s1", now);
    acceptStop(queryClient, "s1");
    vi.advanceTimersByTime(STOP_CATCH_UP_MS - 1);
    expect(stopPending(queryClient, "s1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stopPending(queryClient, "s1")).toBe(false);
  });
});
