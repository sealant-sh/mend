import type { AgentItemDto, AgentRequestDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { stepCommand } from "./checks.ts";
import {
  conversationBody,
  conversationRows,
  latestAgentText,
  addedUnreachableLogin,
  defaultEndpointHost,
  turnEnd,
  turnLasted,
  workingOn,
} from "./conversation-rows.ts";
import { type ConversationView, type TurnView } from "./conversation.ts";

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

describe("the command a step ran", () => {
  // Claude's adapter records the `tool_use` block itself: the tool's name is the title and the
  // command sits in `input.command`. No exit code reaches the item.
  const claudeTest = item("t-1", "command-execution", "2026-11-02T10:00:00.000Z", {
    title: "Bash",
    data: {
      type: "tool_use",
      id: "toolu_01XbQ8Vn3sL2kZ9wR4yT7mPq",
      name: "Bash",
      input: { command: "pnpm --filter @mend/web-old test", description: "Run the web tests" },
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
  const notACheck = item("t-1", "command-execution", "2026-11-02T10:05:00.000Z", {
    title: "Bash",
    data: { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
  });

  it("reads Claude's command from its tool call", () => {
    expect(stepCommand(claudeTest)).toBe("pnpm --filter @mend/web-old test");
  });

  it("reads Codex's command from its own item", () => {
    expect(stepCommand(codexTypecheck)).toBe("pnpm exec turbo typecheck --force");
  });

  it("takes no command from a title that is only the tool's name", () => {
    expect(stepCommand({ ...notACheck, data: null })).toBeNull();
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

  it("points at adding credit when the login's account ran out", () => {
    const conversation: ConversationView = {
      turns: [
        failed(
          "API Error: 400 credit_balance_too_low Your credit balance is too low to access the Anthropic API.",
        ),
      ],
      items: [],
      requests: [],
    };
    const [row] = agentRows(conversation);
    expect(row?.kind === "agent" ? turnEnd(row)?.next : null).toBe("add-credit");
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

  it("says a login's endpoint could not be reached, from where, and when, never why it is", () => {
    const endedAt = new Date(2026, 10, 8, 21, 40, 5).toISOString();
    const conversation: ConversationView = {
      turns: [
        {
          ...failed(
            "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
          ),
          endedAt,
          unreachable: "connection-refused",
        },
      ],
      items: [
        item("t-1", "assistant-message", endedAt, {
          text: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
        }),
      ],
      requests: [],
    };
    const [row] = agentRows(conversation);
    if (row?.kind !== "agent") throw new Error("no agent row");
    expect(turnEnd(row, "gateway.example.com")).toEqual({
      words:
        "Could not reach gateway.example.com from this session's workspace (connection refused) · observed 21:40",
      next: "send-again",
    });
    expect(turnEnd(row)).toEqual({
      words:
        "Could not reach this login's endpoint from the session's workspace (connection refused) · observed 21:40",
      next: "send-again",
    });
  });

  it("names the endpoint's host only to the person whose login the turn ran on", () => {
    const unreachable: TurnView = {
      ...failed("Connection failed: error sending request"),
      billedUserId: "maria",
      unreachable: "connection-failed",
    };
    expect(addedUnreachableLogin(unreachable, "maria")).toBe(true);
    expect(addedUnreachableLogin(unreachable, "bob")).toBe(false);
    expect(addedUnreachableLogin(unreachable, null)).toBe(false);
    expect(addedUnreachableLogin({ ...unreachable, unreachable: null }, "maria")).toBe(false);
    const accounts = [
      { provider: "codex", isDefault: false, login: { kind: "subscription" as const } },
      {
        provider: "codex",
        isDefault: true,
        login: { kind: "api-key" as const, suffix: "a1b2", endpointHost: "gateway.example.com" },
      },
      { provider: "claude", isDefault: true, login: { kind: "api-key" as const, suffix: "c3d4" } },
    ];
    expect(defaultEndpointHost(accounts, "codex")).toBe("gateway.example.com");
    expect(defaultEndpointHost(accounts, "claude")).toBeNull();
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

describe("the conversation while its history is read", () => {
  it("keeps the history already held beside a failed re-read", () => {
    const held: ConversationView = {
      turns: [turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z")],
      items: [item("t-1", "assistant-message", "2026-11-02T10:00:03.000Z")],
      requests: [],
    };
    const body = conversationBody({ status: "error", data: held });
    expect(body.notice).toBe("failed");
    expect(body.rows.map((row) => row.kind)).toEqual(["you", "agent"]);
  });

  it("shows only the notice while nothing is held", () => {
    expect(conversationBody({ status: "pending", data: undefined })).toEqual({
      notice: "reading",
      list: null,
      rows: [],
    });
  });
});

describe("setup a harness wrote as a message", () => {
  const injected =
    "# AGENTS.md instructions for /workspace/repo\n\n<INSTRUCTIONS>\n# Mend\n</INSTRUCTIONS>";
  const rowsSaying = (first: Partial<TurnView>) =>
    conversationRows({
      turns: [
        { ...turn("t-1", 1, "completed", "2026-11-02T10:00:00.000Z"), ...first },
        turn("t-2", 2, "completed", "2026-11-02T10:01:00.000Z"),
      ],
      items: [item("t-2", "assistant-message", "2026-11-02T10:01:01.000Z")],
      requests: [],
    }).flatMap((row) => (row.kind === "you" ? [row.text] : []));

  it("hides the injected AGENTS.md envelope carried over from a terminal", () => {
    expect(rowsSaying({ input: injected })).toEqual(["ask 2"]);
  });

  it("shows a pasted AGENTS.md block with the person's request after it", () => {
    const pasted = `${injected}\n\nPlease review these instructions.`;
    expect(rowsSaying({ input: pasted })).toEqual([pasted, "ask 2"]);
  });

  it("shows a person's own <INSTRUCTIONS> message", () => {
    const typed = "<INSTRUCTIONS>\nRename the flag.\n</INSTRUCTIONS>";
    expect(rowsSaying({ input: typed })).toEqual([typed, "ask 2"]);
  });

  it("shows anything a person sent as a message, even the exact envelope", () => {
    expect(
      rowsSaying({ input: injected, clientMessageId: "7c1e3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8d" }),
    ).toEqual([injected, "ask 2"]);
  });
});

describe("how long a turn ran", () => {
  it("is its measured length", () => {
    expect(
      turnLasted({ startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:00:42.000Z" }),
    ).toBe(42_000);
  });

  it("is not known for a turn carried over from a terminal, or one not yet ended", () => {
    expect(
      turnLasted({ startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:00:00.000Z" }),
    ).toBeNull();
    expect(turnLasted({ startedAt: "2026-11-02T10:00:00.000Z", endedAt: null })).toBeNull();
  });
});
