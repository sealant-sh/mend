import { describe, expect, it } from "vitest";

import type { EventPointer } from "./client.js";
import { conversationWait, limited, readPlan, terminalWait } from "./session-reads.js";
import type { SessionDetail, SessionProcess } from "./types.js";

const event = (
  type: string,
  sessionId: string | null,
  projectId: string | null = "p1",
  facet: string | null = null,
): EventPointer => ({ type, sessionId, projectId, changeId: null, facet });

describe("what a run of event frames re-reads", () => {
  it("re-reads each session a frame names once, and the projects of project frames", () => {
    const plan = readPlan([
      event("session", "s1"),
      event("session-process", "s1"),
      event("agent-conversation", "s2"),
      event("worktree", null, "p2"),
    ]);
    expect([...plan.sessions]).toEqual(["s1", "s2"]);
    expect([...plan.projects]).toEqual(["p2"]);
    expect(plan.all).toBe(false);
  });

  it("reads everything again when the feed resyncs or the roster moves", () => {
    expect(readPlan([event("session", "s1"), event("resync", null, null)]).all).toBe(true);
    expect(readPlan([event("organization", null, null)]).all).toBe(true);
  });

  it("re-reads nothing for progress lines, comments or account facts", () => {
    const plan = readPlan([
      event("session-progress", "s1"),
      event("review-comment", null),
      event("user", null, null, "devices"),
    ]);
    expect(plan.sessions.size + plan.projects.size).toBe(0);
    expect(plan.all).toBe(false);
  });

  it("reads everything again when the account's own access changed", () => {
    expect(readPlan([event("user", null, null, "access")]).all).toBe(true);
  });
});

describe("a bounded fan-out", () => {
  it("runs at most the limit at once and returns results in order", async () => {
    let running = 0;
    let most = 0;
    const results = await limited([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (item) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 11 - item));
      running -= 1;
      return item * 2;
    });
    expect(most).toBe(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it("starts nothing after a failure, and throws once the reads already begun have ended", async () => {
    const started: Array<number> = [];
    let ended = 0;
    const read = limited([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, item === 1 ? 1 : 20));
      ended += 1;
      if (item === 1) throw new Error("refused");
      return item;
    });
    await expect(read).rejects.toThrow("refused");
    expect(started).toEqual([1, 2]);
    expect(ended).toBe(2);
  });
});

const agent = (overrides: Partial<SessionProcess>): SessionProcess => ({
  id: "a1",
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  label: "claude",
  waiting: null,
  ...overrides,
});

const detail = (processes: ReadonlyArray<SessionProcess>): Pick<SessionDetail, "processes"> => ({
  processes,
});

describe("why a session waits", () => {
  const since = "2026-10-19T02:14:00.000Z";

  it("says a terminal agent's wait in G4's words, keyed by its kind and when it began", () => {
    const waiting = agent({ waiting: { kind: "permission", tool: "Bash", since } });
    expect(terminalWait(detail([waiting]))).toEqual({
      key: `permission:${since}`,
      words: "claude needs your permission to use Bash",
      since,
      via: "terminal",
    });
    expect(
      terminalWait(detail([agent({ waiting: { kind: "prompt", tool: null, since } })]))?.words,
    ).toBe("claude finished its turn");
  });

  it("says an older agent's ask over a newer agent's finished turn", () => {
    const asking = agent({ id: "a1", waiting: { kind: "permission", tool: "Bash", since } });
    const finished = agent({ id: "a2", waiting: { kind: "prompt", tool: null, since } });
    expect(terminalWait(detail([asking, finished]))?.words).toBe(
      "claude needs your permission to use Bash",
    );
    expect(terminalWait(detail([agent({ id: "a1" }), finished]))?.words).toBe(
      "claude finished its turn",
    );
  });

  it("reads no wait from an agent that ended", () => {
    const ended = agent({ exitedAt: since, waiting: { kind: "question", tool: null, since } });
    expect(terminalWait(detail([ended]))).toBeNull();
  });

  it("says a conversation's oldest pending request, keyed by the request", () => {
    expect(
      conversationWait([
        { id: "r2", title: "run pnpm db:migrate?", createdAt: "2026-10-19T03:00:00.000Z" },
        { id: "r1", title: "approve schema change?", createdAt: since },
      ]),
    ).toEqual({ key: "r1", words: "approve schema change?", since, via: "conversation" });
    expect(conversationWait([])).toBeNull();
  });
});
