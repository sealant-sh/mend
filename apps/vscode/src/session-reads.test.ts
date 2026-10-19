import { describe, expect, it } from "vitest";

import { conversationWait, readPlan, terminalWait } from "./session-reads.js";
import type { SessionDetail, SessionProcess } from "./types.js";

const event = (type: string, sessionId: string | null, projectId: string | null = "p1") => ({
  type,
  sessionId,
  projectId,
});

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

  it("re-reads nothing for progress lines, comments or account facts", () => {
    const plan = readPlan([
      event("session-progress", "s1"),
      event("review-comment", null),
      event("user", null, null),
    ]);
    expect(plan.sessions.size + plan.projects.size).toBe(0);
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

  it("says a terminal agent's wait in G4's words, keyed by when it began", () => {
    const waiting = agent({ waiting: { kind: "permission", tool: "Bash", since } });
    expect(terminalWait(detail([waiting]))).toEqual({
      key: since,
      words: "claude needs your permission to use Bash",
      since,
      via: "terminal",
    });
    expect(
      terminalWait(detail([agent({ waiting: { kind: "prompt", tool: null, since } })]))?.words,
    ).toBe("claude finished its turn");
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
