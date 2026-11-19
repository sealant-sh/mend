import type { AgentItemDto } from "@mend/agent-conversation";
import { ScreenLogEntry } from "@mend/domain/workbench";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { TurnView } from "./conversation.ts";
import {
  checkpointAt,
  checkpointOfHash,
  commandEndWords,
  durationWords,
  filteredRows,
  type RecordCheckpoint,
  recordRows,
} from "./record-rows.ts";
import { screenLogActor, screenLogWords } from "./screen-log.ts";

const at = (minute: number) => `2026-11-18T11:${String(minute).padStart(2, "0")}:00.000Z`;

const turn: TurnView = {
  id: "t-1",
  sessionId: "s-1",
  ordinal: 0,
  origin: "request",
  author: "ada",
  input: "Checkout charged a customer twice after a 503.\nFind out why.",
  status: "completed",
  error: null,
  createdAt: at(32),
  startedAt: at(32),
  endedAt: at(39),
};

const item = (
  id: string,
  kind: string,
  minute: number,
  extra: Partial<AgentItemDto> = {},
): AgentItemDto => ({
  id,
  seq: minute,
  turnId: "t-1",
  kind,
  status: "completed",
  title: null,
  text: null,
  createdAt: at(minute),
  updatedAt: at(minute),
  ...extra,
});

const items: ReadonlyArray<AgentItemDto> = [
  item("think", "reasoning", 33, { text: "hidden" }),
  item("said", "assistant-message", 34, {
    text: "The retry sends the charge again\nwithout a key.",
  }),
  item("grep", "command-execution", 35, {
    title: "Bash",
    data: { type: "tool_use", name: "Bash", input: { command: 'rg "createCharge" src' } },
  }),
  item("edit", "file-change", 36, { title: "src/payments/retry.ts" }),
  item("test", "command-execution", 38, {
    title: "pnpm vitest run payments",
    data: {
      command: "pnpm vitest run payments",
      cwd: "/workspace/repo",
      aggregatedOutput: "Tests  200 passed (200)",
      exitCode: 1,
      durationMs: 41_200,
    },
  }),
];

const checkpoints: ReadonlyArray<RecordCheckpoint> = [
  {
    id: "c-6",
    ordinal: 6,
    sha: "9c41e07aa1",
    trigger: "turn-boundary",
    createdAt: new Date("2026-11-18T11:35:30.000Z"),
  },
  {
    id: "c-7",
    ordinal: 7,
    sha: "4f2a91c0b3",
    trigger: "user-mark",
    createdAt: new Date("2026-11-18T11:37:30.000Z"),
  },
];

const screenLog = [
  Schema.decodeUnknownSync(ScreenLogEntry)({
    screenId: "scr-1",
    seq: 1,
    at: at(37),
    actor: {
      _tag: "Agent",
      processId: "proc-1",
      turnId: "t-1",
      callKey: "call-1",
      toolCall: { _tag: "Native" },
    },
    body: { _tag: "Looked" },
    frame: null,
    checkpoint: null,
  }),
];

const rows = recordRows({
  conversation: { turns: [turn], items, requests: [] },
  transcript: [],
  checkpoints,
  screenLog,
  agent: "Claude Code",
  nameOf: (userId, fallback = "Mend") => (userId === "ada" ? "You" : (userId ?? fallback)),
  actorOf: (entry) => screenLogActor(entry, "Claude Code", (id) => id),
});

describe("the Record's rows", () => {
  it("lists everything the session did, newest first, and leaves out its thinking", () => {
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ["command", "pnpm vitest run payments"],
      ["checkpoint", "Checkpoint 7 · marked by hand"],
      ["screen", "look"],
      ["edit", "src/payments/retry.ts"],
      ["checkpoint", "Checkpoint 6 · turn ended"],
      ["command", 'rg "createCharge" src'],
      ["message", "The retry sends the charge again without a key."],
      ["message", "Checkout charged a customer twice after a 503. Find out why."],
    ]);
  });

  it("names who said a message and who acted on the screen", () => {
    expect(rows.find((row) => row.key === "turn:t-1")?.who).toBe("You");
    expect(rows.find((row) => row.key === "item:said")?.who).toBe("Claude Code");
    expect(rows.find((row) => row.kind === "screen")?.who).toBe("Claude Code");
  });

  it("opens a Codex command to its output, exit and duration, and a message to all of it", () => {
    const test = rows.find((row) => row.key === "item:test");
    expect(test?.outcome).toBe("exit 1");
    expect(test?.detail).toEqual({
      kind: "command",
      output: "Tests  200 passed (200)",
      exitCode: 1,
      durationMs: 41_200,
      cwd: "/workspace/repo",
      running: false,
    });
    expect(rows.find((row) => row.key === "turn:t-1")?.detail).toEqual({
      kind: "text",
      text: "Checkout charged a customer twice after a 503.\nFind out why.",
    });
  });

  it("opens Claude's command to nothing but the command, since its tool call holds no more", () => {
    const grep = rows.find((row) => row.key === "item:grep");
    if (grep?.detail?.kind !== "command") throw new Error("no command detail");
    expect(grep.outcome).toBeNull();
    expect(commandEndWords(grep.detail)).toBeNull();
    expect(grep.detail.output).toBeNull();
  });

  it("filters by kind", () => {
    expect(filteredRows(rows, "checkpoint").map((row) => row.checkpoint)).toEqual([7, 6]);
    expect(filteredRows(rows, "all")).toHaveLength(rows.length);
  });

  it("puts a terminal session's undated record after everything with a time, newest first", () => {
    const terminal = recordRows({
      conversation: { turns: [], items: [], requests: [] },
      transcript: [
        { kind: "user", text: "run the tests", name: null, command: null, output: null },
        { kind: "tool", text: null, name: "Bash", command: "pnpm test", output: "ok" },
      ],
      checkpoints,
      screenLog: [],
      agent: "Claude Code",
      nameOf: (userId, fallback = "Mend") => userId ?? fallback,
      actorOf: () => "Mend",
    });
    expect(terminal.map((row) => [row.kind, row.at === null, row.text])).toEqual([
      ["checkpoint", false, "Checkpoint 7 · marked by hand"],
      ["checkpoint", false, "Checkpoint 6 · turn ended"],
      ["command", true, "pnpm test"],
      ["message", true, "run the tests"],
    ]);
  });
});

describe("checkpoints in the Record", () => {
  it("puts a row in the newest checkpoint taken at or before it", () => {
    expect(checkpointAt(checkpoints, new Date(at(36)))).toBe(6);
    expect(checkpointAt(checkpoints, new Date(at(35)))).toBeNull();
    expect(checkpointAt(checkpoints, new Date(at(40)))).toBe(7);
    expect(checkpointAt(checkpoints, null)).toBeNull();
  });

  it("reads the checkpoint a pull request's link names", () => {
    expect(checkpointOfHash("checkpoint-6")).toBe(6);
    expect(checkpointOfHash("#checkpoint-12")).toBe(12);
    expect(checkpointOfHash("land")).toBeNull();
    expect(checkpointOfHash("checkpoint-")).toBeNull();
  });
});

describe("a command's end, in words", () => {
  const ended = {
    kind: "command",
    output: null,
    exitCode: 0,
    durationMs: 41_200,
    cwd: null,
    running: false,
  } as const;

  it("says how it exited and after how long", () => {
    expect(commandEndWords(ended)).toBe("It exited with code 0 after 41 seconds.");
    expect(commandEndWords({ ...ended, exitCode: null })).toBe("It ran for 41 seconds.");
    expect(commandEndWords({ ...ended, running: true })).toBe("It's still running.");
  });

  it("says a duration as a person would", () => {
    expect(durationWords(400)).toBe("under a second");
    expect(durationWords(1_000)).toBe("1 second");
    expect(durationWords(124_000)).toBe("2 minutes 4 seconds");
    expect(durationWords(120_000)).toBe("2 minutes");
  });
});

describe("the screen log's words", () => {
  it("says what one entry recorded", () => {
    const [entry] = screenLog;
    if (entry === undefined) throw new Error("no entry");
    expect(screenLogWords(entry)).toBe("look");
    expect(
      screenLogWords({
        ...entry,
        body: { _tag: "PersonInput", clicks: 2, keys: 1, pastes: 0 },
      }),
    ).toBe("2 clicks, 1 key");
  });
});
