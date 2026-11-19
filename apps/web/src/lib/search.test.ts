import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { inboxRows } from "./inbox.ts";
import {
  allHits,
  countWords,
  type SearchHit,
  searchResults,
  type SearchSources,
  sessionStatus,
} from "./search.ts";

const now = new Date("2026-11-18T14:00:00");

const session = (
  id: string,
  title: string,
  status: SessionInboxRowDto["session"]["status"],
  minutesAgo: number,
): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(id),
    projectId: ProjectId.make("checkout-api"),
    worktreeId: WorktreeId.make(`wt-${id}`),
    harness: "claude",
    label: null,
    branch: `mend/${id}`,
    status,
    ownerUserId: "ada",
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: now,
    settledAt: null,
    createdAt: now,
    updatedAt: new Date(now.getTime() - minutesAgo * 60_000),
    importedConversationWaiting: false,
  },
  projectName: "checkout-api",
  title,
  annotation: null,
  ask: null,
  worktreeName: null,
  failure: null,
  activity: null,
});

const sources: SearchSources = {
  sessions: inboxRows({
    rows: [
      session("s1", "Fix flaky checkout retry", "waiting", 4),
      session("s2", "Upgrade to React Router 8", "failed", 22),
      session("s3", "Update landing page pricing", "completed", 60),
      session("s4", "Mobile landing screen for gift cards", "stopped", 120),
      session("s5", "Add idempotency keys to refunds", "running", 10),
    ],
    marks: [],
    now,
  }),
  projects: [
    { id: "p1", name: "checkout-api", repository: "github.com/northwind/checkout-api" },
    { id: "p2", name: "landing-site", repository: "github.com/northwind/landing-site" },
  ],
  skills: [
    { id: "k1", name: "release-notes" },
    { id: "k2", name: "landing-checklist" },
  ],
  actions: [
    { id: "new-session", name: "New session" },
    { id: "add-project", name: "Add project…" },
  ],
};

const names = (hits: ReadonlyArray<SearchHit>) =>
  hits.map((hit) => (hit.kind === "session" ? hit.row.title : hit.key));

describe("searchResults", () => {
  it("lists the most recent sessions and every action with nothing typed, and no count", () => {
    const results = searchResults(sources, "  ", 3);
    expect(results.groups.map((group) => group.heading)).toEqual(["Recent sessions", "Actions"]);
    expect(names(results.groups[0]?.hits ?? [])).toEqual([
      "Fix flaky checkout retry",
      "Add idempotency keys to refunds",
      "Upgrade to React Router 8",
    ]);
    expect(results.count).toBeNull();
  });

  it("finds sessions, projects and skills by name, grouped, best match first", () => {
    const results = searchResults(sources, "land", 4);
    expect(results.groups.map((group) => group.heading)).toEqual([
      "Sessions",
      "Projects",
      "Skills",
    ]);
    expect(names(results.groups[0]?.hits ?? [])).toEqual([
      "Update landing page pricing",
      "Mobile landing screen for gift cards",
    ]);
    expect(names(allHits(results).slice(2))).toEqual(["project:p2", "skill:k2"]);
    expect(results.count).toBe(4);
  });

  it("marks the typed letters of each name", () => {
    const [first] = allHits(searchResults(sources, "land", 4));
    // "Update landing page pricing": "land" starts at 7.
    expect(first?.indices).toEqual([7, 8, 9, 10]);
  });

  it("lists actions first when one matches", () => {
    const results = searchResults(sources, "new", 4);
    expect(results.groups[0]?.heading).toBe("Actions");
    expect(names(results.groups[0]?.hits ?? [])).toEqual(["action:new-session"]);
  });

  it("finds nothing for a query no name holds", () => {
    expect(searchResults(sources, "helm chart", 4)).toEqual({ groups: [], count: 0 });
  });
});

describe("words", () => {
  it("counts results", () => {
    expect(countWords(0)).toBe("0 results");
    expect(countWords(1)).toBe("1 result");
    expect(countWords(4)).toBe("4 results");
  });

  it("says a session's status, amber when it waits on you and red when it failed", () => {
    const [waiting, , failed] = sources.sessions;
    expect(waiting === undefined ? null : sessionStatus(waiting)).toEqual({
      word: "Waiting on you",
      tone: "wait",
    });
    expect(failed === undefined ? null : sessionStatus(failed)).toEqual({
      word: "Failed",
      tone: "bad",
    });
  });

  it("names what a waiting session waits on, as its inbox row does", () => {
    const [asking] = inboxRows({
      rows: [
        {
          ...session("s6", "Rotate staging database credentials", "waiting", 2),
          ask: { kind: "command", subject: "terraform apply" },
        },
      ],
      marks: [],
      now,
    });
    expect(asking === undefined ? null : sessionStatus(asking)).toEqual({
      word: "Wants to run terraform apply",
      tone: "wait",
    });
  });
});
