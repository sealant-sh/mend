import type { AgentItemDto, AgentRequestDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { observedChecks } from "./checks.ts";
import { conversationRows, latestAgentText, workingOn } from "./conversation-rows.ts";
import type { ConversationView, TurnView } from "./conversation.ts";

const turn = (id: string, ordinal: number, status: string, at: string): TurnView => ({
  id,
  sessionId: "s-1",
  ordinal,
  origin: "request",
  author: "alice",
  input: `ask ${ordinal}`,
  status,
  error: null,
  createdAt: at,
  startedAt: at,
  endedAt: status === "running" ? null : at.replace(":00.000Z", ":42.000Z"),
});

let seq = 0;
const item = (
  turnId: string,
  kind: string,
  at: string,
  extra: Partial<AgentItemDto> = {},
): AgentItemDto => {
  seq += 1;
  return {
    id: `i-${seq}`,
    seq,
    turnId,
    kind,
    status: "completed",
    title: kind === "command-execution" ? "pnpm test" : null,
    text: kind === "assistant-message" ? `said ${seq}` : null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
};

const request = (turnId: string, at: string): AgentRequestDto => ({
  id: "r-1",
  turnId,
  kind: "command-approval",
  title: null,
  detail: null,
  questions: null,
  status: "pending",
  decision: null,
  answers: null,
  createdAt: at,
});

describe("the conversation's rows", () => {
  const done = turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z");
  const open = turn("t-2", 2, "running", "2026-11-02T10:05:00.000Z");
  const conversation: ConversationView = {
    turns: [open, done],
    items: [
      item("t-1", "reasoning", "2026-11-02T10:00:01.000Z"),
      item("t-1", "command-execution", "2026-11-02T10:00:02.000Z"),
      item("t-1", "assistant-message", "2026-11-02T10:00:03.000Z"),
      item("t-2", "assistant-message", "2026-11-02T10:05:01.000Z"),
      item("t-2", "command-execution", "2026-11-02T10:05:02.000Z"),
      item("t-2", "file-change", "2026-11-02T10:05:03.000Z", {
        status: "in-progress",
        title: "src/a.ts",
      }),
    ],
    requests: [request("t-2", "2026-11-02T10:05:04.000Z")],
  };
  const rows = conversationRows(conversation);

  it("puts each message before its reply, in turn order", () => {
    expect(rows.map((row) => row.kind)).toEqual(["you", "agent", "you", "agent"]);
    expect(rows[0]?.kind === "you" ? rows[0].text : null).toBe("ask 1");
  });

  it("folds a finished turn's steps and leaves its words, never its reasoning", () => {
    const reply = rows[1];
    if (reply?.kind !== "agent") throw new Error("no reply");
    expect(reply.open).toBe(false);
    expect(reply.segments.map((segment) => segment.kind)).toEqual(["text"]);
    expect(reply.folded.map((step) => step.kind)).toEqual(["command-execution"]);
  });

  it("shows an open turn's steps where they happened, grouped, then what it asks", () => {
    const reply = rows[3];
    if (reply?.kind !== "agent") throw new Error("no reply");
    expect(reply.open).toBe(true);
    expect(reply.segments.map((segment) => segment.kind)).toEqual(["text", "steps", "request"]);
    const steps = reply.segments[1];
    expect(steps?.kind === "steps" ? steps.items.length : 0).toBe(2);
  });

  it("names the newest words and the step in progress", () => {
    expect(latestAgentText(conversation)?.turnId).toBe("t-2");
    expect(workingOn(conversation)?.title).toBe("src/a.ts");
  });
});

describe("observed checks", () => {
  it("keeps the latest run of each check command and says how it ended", () => {
    const checks = observedChecks([
      item("t-1", "command-execution", "2026-11-02T10:00:00.000Z", {
        title: "pnpm test",
        status: "failed",
      }),
      item("t-1", "command-execution", "2026-11-02T10:01:00.000Z", {
        title: "pnpm test",
        data: { exitCode: 0 },
      }),
      item("t-1", "command-execution", "2026-11-02T10:02:00.000Z", { title: "ls -la" }),
      item("t-1", "command-execution", "2026-11-02T10:03:00.000Z", {
        title: "pnpm exec turbo typecheck --force",
        data: { exitCode: 2 },
      }),
    ]);
    expect(checks.map((check) => [check.command, check.result, check.exitCode])).toEqual([
      ["pnpm exec turbo typecheck --force", "failed", 2],
      ["pnpm test", "passed", 0],
    ]);
  });
});
