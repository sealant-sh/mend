import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { invalidationsFor } from "./event-scope.ts";
import { makeTrpcProxy } from "./trpc.ts";

const queryClient = new QueryClient();
const trpc = makeTrpcProxy(queryClient);

/** Every read a page holds open, named as the requests would be: `path(input)`. */
const nameOf = (key: QueryKey): string => {
  const [path, meta] = key;
  const input =
    typeof meta === "object" && meta !== null && "input" in meta ? JSON.stringify(meta.input) : "";
  return `${Array.isArray(path) ? path.join(".") : String(path)}(${input ?? ""})`;
};

const PROJECTS = Array.from({ length: 13 }, (_, n) => `p${n + 1}`);
const SESSIONS = ["s1", "s2", "s3", "s4", "s5"];

/** What a person's open tab holds live: the box's 13 projects, a few sessions and their reads. */
const OPEN: ReadonlyArray<QueryKey> = [
  trpc.sessions.inbox.queryKey(),
  trpc.sessions.listActive.queryKey(),
  trpc.projects.list.queryKey(),
  ...PROJECTS.map((id) => trpc.projects.detail.queryKey({ id })),
  ...SESSIONS.flatMap((id) => [
    trpc.sessions.detail.queryKey({ id }),
    trpc.sessions.pendingFollowUp.queryKey({ id }),
    trpc.screens.read.queryKey({ id }),
    trpc.landings.forSession.queryKey({ id }),
  ]),
  trpc.worktrees.list.queryKey({ projectId: "p1" }),
  trpc.worktrees.list.queryKey({ projectId: "p2" }),
  trpc.changes.comments.queryKey({ id: "c1" }),
  trpc.changes.comments.queryKey({ id: "c2" }),
];

let requests: Array<string> = [];
const unsubscribes: Array<() => void> = [];

const openTab = async () => {
  for (const queryKey of OPEN) {
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => {
        requests.push(nameOf(queryKey));
        return {};
      },
      staleTime: Infinity,
    });
    unsubscribes.push(observer.subscribe(() => undefined));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  requests = [];
};

/** The requests one event sends from that tab. */
const requestsFor = async (event: Parameters<typeof invalidationsFor>[0]) => {
  await openTab();
  await Promise.all(
    invalidationsFor(event, trpc).map((filter) => queryClient.invalidateQueries(filter)),
  );
  return requests.toSorted();
};

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  queryClient.clear();
});

describe("what one event reads again, from a tab holding 13 projects and 5 sessions", () => {
  it("a session's status: that session's reads, its project's page and the live list", async () => {
    expect(await requestsFor({ type: "session", sessionId: "s1", projectId: "p1" })).toEqual([
      'projects.detail({"id":"p1"})',
      'screens.read({"id":"s1"})',
      'sessions.detail({"id":"s1"})',
      "sessions.listActive()",
      'sessions.pendingFollowUp({"id":"s1"})',
    ]);
  });

  it("a turn, an item or a request: that session's reads and its landing, no project", async () => {
    expect(
      await requestsFor({ type: "agent-conversation", sessionId: "s2", projectId: "p1" }),
    ).toEqual([
      'landings.forSession({"id":"s2"})',
      'screens.read({"id":"s2"})',
      'sessions.detail({"id":"s2"})',
      'sessions.pendingFollowUp({"id":"s2"})',
    ]);
  });

  it("a worktree: its project's worktree list and page", async () => {
    expect(await requestsFor({ type: "worktree", worktreeId: "w1", projectId: "p2" })).toEqual([
      'projects.detail({"id":"p2"})',
      'worktrees.list({"projectId":"p2"})',
    ]);
  });

  it("a review comment: that change's comments, its worktree list and its project", async () => {
    expect(
      await requestsFor({
        type: "review-comment",
        changeId: "c1",
        worktreeId: "w1",
        projectId: "p1",
      }),
    ).toEqual([
      'changes.comments({"id":"c1"})',
      'projects.detail({"id":"p1"})',
      'worktrees.list({"projectId":"p1"})',
    ]);
  });

  it("a project's setting: that project's page and the project list", async () => {
    expect(await requestsFor({ type: "project", projectId: "p7" })).toEqual([
      'projects.detail({"id":"p7"})',
      "projects.list()",
    ]);
  });

  it("an organization's membership: the lists of what a person sees, no project's detail", async () => {
    expect(
      await requestsFor({ type: "organization", projectId: undefined, sessionId: undefined }),
    ).toEqual(["projects.list()", "sessions.listActive()"]);
  });

  it("never reads more than one project's detail, nor the inbox's list, for any event but a resync", async () => {
    for (const type of [
      "project",
      "session",
      "agent-conversation",
      "session-process",
      "worktree",
      "session-change",
      "review-comment",
      "organization",
      "session-progress",
      "user",
    ]) {
      const sent = await requestsFor({
        type,
        sessionId: "s1",
        projectId: "p1",
        worktreeId: "w1",
        changeId: "c1",
      });
      expect(sent.filter((name) => name.startsWith("projects.detail")).length).toBeLessThanOrEqual(
        1,
      );
      expect(sent).not.toContain("sessions.inbox()");
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      queryClient.clear();
    }
  });
});
