import { describe, expect, it } from "vitest";

import type { ProjectDto, SessionDto, SessionProcessDto } from "./api.ts";
import { annotationFixture, processFixture, projectFixture, sessionFixture } from "./fixtures.ts";
import { SETTLED_INITIAL } from "./inbox-shelves.ts";
import { buildInbox, buildTree, scopeInbox, visibleInboxRows } from "./model.ts";

const project = (id: string): ProjectDto => projectFixture({ id, name: id });

const session = (
  id: string,
  projectId: string,
  status: SessionDto["status"],
  createdAt: string,
  settledAt: string | null = null,
): SessionDto =>
  sessionFixture({
    id,
    projectId,
    label: id,
    worktree: id,
    branch: id,
    status,
    startedAt: createdAt,
    settledAt,
    createdAt,
  });

const now = Date.parse("2026-08-21T12:00:00.000Z");
const data = [
  {
    project: project("p1"),
    sessions: [
      session("old-running", "p1", "running", "2026-08-21T08:00:00.000Z"),
      session("new-idle", "p1", "idle", "2026-08-21T11:00:00.000Z"),
      session(
        "done-early",
        "p1",
        "completed",
        "2026-08-20T08:00:00.000Z",
        "2026-08-20T09:00:00.000Z",
      ),
      session(
        "done-late",
        "p1",
        "completed",
        "2026-08-19T08:00:00.000Z",
        "2026-08-21T09:00:00.000Z",
      ),
      session("shell", "p1", "running", "2026-08-21T11:30:00.000Z"),
    ].map((row) => (row.id === "shell" ? { ...row, harness: "shell" } : row)),
  },
  {
    project: project("p2"),
    sessions: [session("p2-waiting", "p2", "waiting", "2026-08-21T10:00:00.000Z")],
  },
];

describe("buildInbox", () => {
  it("orders active by creation (newest first), settled by when work ended, and drops shells", () => {
    const inbox = buildInbox(data, {}, {}, now);
    expect(inbox.active.map((row) => row.session.id)).toEqual([
      "new-idle",
      "p2-waiting",
      "old-running",
    ]);
    expect(inbox.settled.map((row) => row.session.id)).toEqual(["done-late", "done-early"]);
    expect(inbox.ordered.some((row) => row.session.id === "shell")).toBe(false);
  });

  it("parks a snoozed row on its own shelf, soonest wake first, until it raises a hand", () => {
    const snoozes = {
      "old-running": { until: "2026-08-22T09:00:00.000Z", at: "2026-08-21T11:00:00.000Z" },
      "new-idle": { until: "2026-08-21T18:00:00.000Z", at: "2026-08-21T11:30:00.000Z" },
      "p2-waiting": { until: "2026-08-22T09:00:00.000Z", at: "2026-08-21T11:00:00.000Z" },
    };
    const inbox = buildInbox(data, {}, snoozes, now);
    expect(inbox.snoozed.map((row) => row.session.id)).toEqual(["new-idle", "old-running"]);
    // waiting on you outranks the snooze
    expect(inbox.active.map((row) => row.session.id)).toEqual(["p2-waiting"]);
    expect(inbox.snoozed[0]?.wakeAt).toBe("2026-08-21T18:00:00.000Z");
  });

  it("recedes in-flight rows and holds weight only for input, failure, and unseen done", () => {
    const inbox = buildInbox(data, { "done-late": "2026-08-21T08:00:00.000Z" }, {}, now);
    const byId = new Map(inbox.ordered.map((row) => [row.session.id, row]));
    expect(byId.get("old-running")?.recede).toBe(true);
    expect(byId.get("p2-waiting")?.recede).toBe(false);
    expect(byId.get("done-late")?.unseen).toBe(true);
    expect(byId.get("done-late")?.slot?.word).toBe("done");
    // never visited counts as read
    expect(byId.get("done-early")?.unseen).toBe(false);
  });
});

const agent = (exitedAt: string | null, exitCode: number | null): SessionProcessDto =>
  processFixture({
    id: "agent-1",
    sessionId: "idle-done",
    label: "claude",
    argv: ["claude"],
    status: exitedAt === null ? "running" : "exited",
    exitCode,
    createdAt: "2026-08-21T10:00:00.000Z",
    exitedAt,
    updatedAt: exitedAt ?? "2026-08-21T10:00:00.000Z",
  });
const annotation = (currentAgent: SessionProcessDto | null) =>
  annotationFixture({ sessionId: "idle-done", currentAgent });

describe("buildInbox with the current agent process", () => {
  it("shows an idle session whose agent ended by the agent's outcome — the shell is you", () => {
    const inbox = buildInbox(
      [
        {
          project: project("p1"),
          sessions: [session("idle-done", "p1", "idle", "2026-08-21T10:00:00.000Z")],
          annotations: [annotation(agent("2026-08-21T11:30:00.000Z", 0))],
        },
      ],
      // Visited before the agent ended: the settle is unseen, so "done" shows.
      { "idle-done": "2026-08-21T10:30:00.000Z" },
      {},
      now,
    );
    expect(inbox.active).toEqual([]);
    expect(inbox.settled.map((row) => row.session.id)).toEqual(["idle-done"]);
    expect(inbox.settled[0]?.slot?.word).toBe("done");
    expect(inbox.settled[0]?.endedAt).toBe("2026-08-21T11:30:00.000Z");
  });

  it("keeps a stopped agent's session active while its Services keep the workspace up", () => {
    const stopped = { ...agent("2026-08-21T11:30:00.000Z", null), status: "stopped" as const };
    const inbox = buildInbox(
      [
        {
          project: project("p1"),
          sessions: [session("idle-done", "p1", "idle", "2026-08-21T10:00:00.000Z")],
          annotations: [
            annotationFixture({ sessionId: "idle-done", currentAgent: stopped, liveServices: 2 }),
          ],
        },
      ],
      {},
      {},
      now,
    );
    expect(inbox.settled).toEqual([]);
    expect(inbox.active[0]?.hold).toBe("agent stopped · 2 services keep the workspace up");
  });

  it("keeps a failed agent's weight behind an idle session", () => {
    const inbox = buildInbox(
      [
        {
          project: project("p1"),
          sessions: [session("idle-done", "p1", "idle", "2026-08-21T10:00:00.000Z")],
          annotations: [annotation(agent("2026-08-21T11:30:00.000Z", 2))],
        },
      ],
      {},
      {},
      now,
    );
    expect(inbox.settled[0]?.slot?.word).toBe("failed");
    expect(inbox.settled[0]?.recede).toBe(false);
  });

  it("leaves a truly idle session (no agent ever) on the active shelf", () => {
    const inbox = buildInbox(
      [
        {
          project: project("p1"),
          sessions: [session("idle-done", "p1", "idle", "2026-08-21T10:00:00.000Z")],
          annotations: [annotation(null)],
        },
      ],
      {},
      {},
      now,
    );
    expect(inbox.active.map((row) => row.session.id)).toEqual(["idle-done"]);
    expect(inbox.active[0]?.slot).toBeNull();
  });
});

describe("scopeInbox + visibleInboxRows", () => {
  const inbox = buildInbox(data, {}, {}, now);

  it("scopes without re-ranking", () => {
    const scoped = scopeInbox(inbox, "p1");
    expect(scoped.active.map((row) => row.session.id)).toEqual(["new-idle", "old-running"]);
    expect(scopeInbox(inbox, null)).toBe(inbox);
  });

  it("numbers only what is rendered, and always the focused row", () => {
    const shelves = {
      settledExpanded: false,
      snoozedExpanded: false,
      settledShown: SETTLED_INITIAL,
    };
    expect(visibleInboxRows(inbox, shelves, null).map((row) => row.session.id)).toEqual([
      "new-idle",
      "p2-waiting",
      "old-running",
    ]);
    expect(visibleInboxRows(inbox, shelves, "done-early").map((row) => row.session.id)).toEqual([
      "new-idle",
      "p2-waiting",
      "old-running",
      "done-early",
    ]);
    const paged = { settledExpanded: true, snoozedExpanded: false, settledShown: 1 };
    expect(visibleInboxRows(inbox, paged, null).map((row) => row.session.id)).toEqual([
      "new-idle",
      "p2-waiting",
      "old-running",
      "done-late",
    ]);
  });
});

describe("buildTree", () => {
  it("keeps every session, shell sessions included: live newest first, then settled", () => {
    const tree = buildTree(data, {}, now);
    expect(tree[0]?.rows.map((row) => row.session.id)).toEqual([
      "shell",
      "new-idle",
      "old-running",
      "done-late",
      "done-early",
    ]);
    expect(tree[0]?.rows[0]?.title).toBe("shell · shell");
  });
});
