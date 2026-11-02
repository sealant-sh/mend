import type { AgentItemDto, AgentRequestDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { observedChecks } from "./checks.ts";
import {
  conversationBody,
  conversationRows,
  latestAgentText,
  turnEnd,
  withOutbox,
  workingOn,
} from "./conversation-rows.ts";
import type { ConversationView, TurnView } from "./conversation.ts";
import type { OutboxMessage } from "./outbox.ts";

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
  // Claude's adapter records the `tool_use` block itself: the tool's name is the title and the
  // command sits in `input.command`. No exit code reaches the item.
  const claudeTest = item("t-1", "command-execution", "2026-11-02T10:00:00.000Z", {
    title: "Bash",
    data: {
      type: "tool_use",
      id: "toolu_01XbQ8Vn3sL2kZ9wR4yT7mPq",
      name: "Bash",
      input: { command: "pnpm --filter @mend/web test", description: "Run the web tests" },
    },
  });
  // Codex's app server records its `commandExecution` thread item, exit code and all.
  const codexTypecheck = item("t-1", "command-execution", "2026-11-02T10:03:00.000Z", {
    title: "pnpm exec turbo typecheck --force",
    data: {
      type: "commandExecution",
      id: "call_7Hk2",
      pluginId: null,
      scriptPath: null,
      command: "pnpm exec turbo typecheck --force",
      cwd: "/workspace/repo",
      processId: "proc-4",
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "pnpm exec turbo typecheck --force" }],
      aggregatedOutput: "Tasks: 31 successful, 32 total",
      exitCode: 2,
      durationMs: 19104,
    },
  });
  const codexLint = item("t-1", "command-execution", "2026-11-02T10:04:00.000Z", {
    title: "pnpm exec turbo lint",
    data: { type: "commandExecution", command: "pnpm exec turbo lint", exitCode: 0 },
  });
  const notACheck = item("t-1", "command-execution", "2026-11-02T10:05:00.000Z", {
    title: "Bash",
    data: { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
  });

  it("reads Claude's command from its tool call, and leaves its outcome unknown", () => {
    const [check] = observedChecks([claudeTest]);
    expect(check).toEqual({
      command: "pnpm --filter @mend/web test",
      result: "unknown",
      exitCode: null,
      at: "2026-11-02T10:00:00.000Z",
    });
  });

  it("reads Codex's exit code, newest check first, and skips commands that check nothing", () => {
    const checks = observedChecks([claudeTest, codexTypecheck, codexLint, notACheck]);
    expect(checks.map((check) => [check.command, check.result, check.exitCode])).toEqual([
      ["pnpm exec turbo lint", "passed", 0],
      ["pnpm exec turbo typecheck --force", "failed", 2],
      ["pnpm --filter @mend/web test", "unknown", null],
    ]);
  });

  it("keeps the latest run of a command", () => {
    const again = {
      ...codexTypecheck,
      id: "again",
      updatedAt: "2026-11-02T10:09:00.000Z",
      data: { command: "pnpm exec turbo typecheck --force", exitCode: 0 },
    };
    expect(observedChecks([codexTypecheck, again])[0]?.result).toBe("passed");
  });
});

const message = (
  clientMessageId: string,
  text: string,
  state: OutboxMessage["state"] = { _tag: "Sending" },
): OutboxMessage => ({ clientMessageId, text, sentAt: "2026-11-02T10:01:00.000Z", state });

const you = (rows: ReturnType<typeof withOutbox>) =>
  rows.flatMap((row) =>
    row.kind === "you" ? [{ key: row.key, text: row.text, state: row.outbox?.state._tag }] : [],
  );

describe("the sender's own messages laid over the conversation", () => {
  const KEY_A = "7c1e3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8a";
  const KEY_B = "7c1e3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8b";
  const done = turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z");
  const before: ConversationView = {
    turns: [done],
    items: [item("t-1", "assistant-message", "2026-11-02T10:00:03.000Z")],
    requests: [],
  };

  it("shows a message on its way as a bubble at the end, in the order sent", () => {
    const rows = withOutbox(
      conversationRows(before),
      before,
      [message(KEY_A, "first"), message(KEY_B, "second")],
      "alice",
    );
    expect(rows.map((row) => row.kind)).toEqual(["you", "agent", "you", "you"]);
    expect(you(rows).slice(1)).toEqual([
      { key: `message:${KEY_A}`, text: "first", state: "Sending" },
      { key: `message:${KEY_B}`, text: "second", state: "Sending" },
    ]);
  });

  it("shows a message once when its turn arrives with its key, under the same row key", () => {
    const after: ConversationView = {
      ...before,
      turns: [
        done,
        {
          ...turn("t-2", 2, "running", "2026-11-02T10:01:01.000Z"),
          input: "first",
          clientMessageId: KEY_A,
        },
      ],
    };
    const rows = withOutbox(conversationRows(after), after, [message(KEY_A, "first")], "alice");
    expect(you(rows)).toEqual([
      { key: "turn:t-1", text: "ask 1", state: undefined },
      { key: `message:${KEY_A}`, text: "first", state: undefined },
    ]);
  });

  it("shows a message once when the turn Mend's answer named arrives without a key", () => {
    const after: ConversationView = {
      ...before,
      turns: [done, { ...turn("t-2", 2, "queued", "2026-11-02T10:01:01.000Z"), input: "first" }],
    };
    const sent = message(KEY_A, "first", {
      _tag: "Sent",
      turnId: "t-2",
      steerId: null,
      explanation: "sent as your next turn",
    });
    expect(you(withOutbox(conversationRows(after), after, [sent], "alice"))).toHaveLength(2);
  });

  it("shows a steer queued for the next turn once, as that turn's message", () => {
    const after: ConversationView = {
      ...before,
      turns: [
        {
          ...done,
          steers: [
            {
              id: "st-1",
              turnId: "t-1",
              ordinal: 1,
              author: "alice",
              input: "first",
              createdAt: "2026-11-02T10:01:01.000Z",
              delivery: { _tag: "Queued", turnId: "t-2", reason: "turn-ended" },
              clientMessageId: KEY_A,
            },
          ],
        },
        { ...turn("t-2", 2, "queued", "2026-11-02T10:01:02.000Z"), fromSteer: "st-1" },
      ],
    };
    const rows = withOutbox(conversationRows(after), after, [message(KEY_A, "first")], "alice");
    expect(you(rows).map((row) => [row.key, row.text])).toEqual([
      ["turn:t-1", "ask 1"],
      [`message:${KEY_A}`, "first"],
    ]);
  });

  it("keeps a refused message's Retry and Edit on the server's row when Mend recorded it", () => {
    const after: ConversationView = {
      ...before,
      turns: [
        done,
        {
          ...turn("t-2", 2, "cancelled", "2026-11-02T10:01:01.000Z"),
          startedAt: null,
          input: "first",
          clientMessageId: KEY_A,
        },
      ],
    };
    const refused = message(KEY_A, "first", {
      _tag: "NotSent",
      words: "not sent · the session stopped",
      nextKey: null,
    });
    expect(you(withOutbox(conversationRows(after), after, [refused], "alice"))).toEqual([
      { key: "turn:t-1", text: "ask 1", state: undefined },
      { key: `message:${KEY_A}`, text: "first", state: "NotSent" },
    ]);
  });

  it("keeps a message that did not arrive as its bubble, saying so", () => {
    const rows = withOutbox(
      conversationRows(before),
      before,
      [message(KEY_A, "first", { _tag: "Unconfirmed" })],
      "alice",
    );
    expect(you(rows).at(-1)).toEqual({
      key: `message:${KEY_A}`,
      text: "first",
      state: "Unconfirmed",
    });
  });
});

const agentRows = (conversation: ConversationView) =>
  conversationRows(conversation).filter((row) => row.kind === "agent");

describe("a turn that did not finish as asked", () => {
  const failed = (error: string | null, id = "t-1", ordinal = 1): TurnView => ({
    ...turn(id, ordinal, "failed", "2026-11-02T10:00:00.000Z"),
    error,
  });

  it("gets a row of its own when the agent said nothing, after its message", () => {
    const conversation: ConversationView = {
      turns: [
        failed("Not logged in · Please run /login"),
        turn("t-2", 2, "completed", "2026-11-02T10:01:00.000Z"),
      ],
      items: [item("t-2", "assistant-message", "2026-11-02T10:01:01.000Z")],
      requests: [],
    };
    const rows = conversationRows(conversation);
    expect(rows.map((row) => [row.kind, row.kind === "agent" ? row.turn?.id : row.text])).toEqual([
      ["you", "ask 1"],
      ["agent", "t-1"],
      ["you", "ask 2"],
      ["agent", "t-2"],
    ]);
    const [first] = agentRows(conversation);
    expect(first?.kind === "agent" ? turnEnd(first) : null).toEqual({
      words: "The turn failed: Not logged in · Please run /login",
      next: "connect-login",
    });
  });

  it("points at the login when the agent's own words say it is the trouble", () => {
    const conversation: ConversationView = {
      turns: [failed("Claude process ended during the turn.")],
      items: [
        item("t-1", "assistant-message", "2026-11-02T10:00:01.000Z", {
          text: "Not logged in · Please run /login",
        }),
      ],
      requests: [],
    };
    const [row] = agentRows(conversation);
    expect(row?.kind === "agent" ? turnEnd(row) : null).toEqual({
      words: "The turn failed: Claude process ended during the turn.",
      next: "connect-login",
    });
  });

  it("asks for another message after any other failure, and after an interrupt", () => {
    const broken: ConversationView = {
      turns: [failed("Codex process ended during the turn.")],
      items: [],
      requests: [],
    };
    const [row] = agentRows(broken);
    expect(row?.kind === "agent" ? turnEnd(row)?.next : null).toBe("send-again");
    const stopped: ConversationView = {
      turns: [turn("t-1", 1, "interrupted", "2026-11-02T10:00:00.000Z")],
      items: [],
      requests: [],
    };
    const [interrupted] = agentRows(stopped);
    expect(interrupted?.kind === "agent" ? turnEnd(interrupted) : null).toEqual({
      words: "The turn was interrupted.",
      next: "send-again",
    });
  });

  it("adds nothing for a turn that finished or still runs with nothing said", () => {
    const quiet: ConversationView = {
      turns: [
        turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z"),
        turn("t-2", 2, "running", "2026-11-02T10:01:00.000Z"),
      ],
      items: [],
      requests: [],
    };
    expect(agentRows(quiet)).toEqual([]);
  });
});

const bubbles = (body: ReturnType<typeof conversationBody>) =>
  body.rows.flatMap((row) => (row.kind === "you" && row.outbox !== null ? [row.text] : []));

describe("the conversation while its history is read", () => {
  const KEY = "7c1e3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8c";
  const sending = message(KEY, "sent while the history loads");

  it("shows a message sent while the history is still being read, beside that notice", () => {
    const body = conversationBody({ status: "pending", data: undefined }, [sending], "alice");
    expect(body.notice).toBe("reading");
    expect(body.list).toBe("protocol");
    expect(bubbles(body)).toEqual(["sent while the history loads"]);
  });

  it("shows it, with its Retry and Edit, when the history did not load", () => {
    const refused = message(KEY, "sent while the history failed", {
      _tag: "NotSent",
      words: "refused",
      nextKey: KEY,
    });
    const body = conversationBody({ status: "error", data: undefined }, [refused], "alice");
    expect(body.notice).toBe("failed");
    expect(body.rows.map((row) => (row.kind === "you" ? row.outbox?.state._tag : null))).toEqual([
      "NotSent",
    ]);
  });

  it("keeps the history already held beside a failed re-read", () => {
    const held: ConversationView = {
      turns: [turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z")],
      items: [item("t-1", "assistant-message", "2026-11-02T10:00:03.000Z")],
      requests: [],
    };
    const body = conversationBody({ status: "error", data: held }, [sending], "alice");
    expect(body.notice).toBe("failed");
    expect(body.rows.map((row) => row.kind)).toEqual(["you", "agent", "you"]);
  });

  it("shows only the notice while nothing is held and nothing was sent", () => {
    expect(conversationBody({ status: "pending", data: undefined }, [], "alice")).toEqual({
      notice: "reading",
      list: null,
      rows: [],
    });
  });
});
