import { describe, expect, it } from "vitest";

import type { ConversationRow } from "./conversation-rows.ts";
import { messageTime, withCheckpoints, withLandings } from "./session-sheet.ts";
import type { CheckpointMark } from "./turn-checkpoints.ts";

const you = (key: string, at: string): ConversationRow => ({
  kind: "you",
  key,
  text: key,
  author: "ada",
  at,
  steer: null,
  outbox: null,
  clientMessageId: null,
});

const agent = (key: string, at: string, turnId: string | null = null): ConversationRow => ({
  kind: "agent",
  key,
  turn:
    turnId === null
      ? null
      : {
          id: turnId,
          sessionId: "s-1",
          ordinal: 1,
          input: "",
          status: "completed",
          error: null,
          createdAt: at,
          startedAt: at,
          endedAt: at,
        },
  at,
  open: false,
  segments: [],
  folded: [],
});

const mark = (ordinal: number, at: string, turnId: string): CheckpointMark => ({
  key: `checkpoint:${ordinal}`,
  turnId,
  ordinal,
  sha: "3f2a1c0",
  at,
  fromId: null,
  toId: `c-${ordinal}`,
  files: { count: 1, more: false, paths: ["a.ts"] },
});

const shown = (entries: ReturnType<typeof withCheckpoints>) =>
  entries.map((entry) =>
    entry.kind === "row"
      ? entry.row.key
      : entry.kind === "checkpoint"
        ? `#${entry.mark.ordinal}`
        : entry.key,
  );

const landed = (key: string, at: string) => ({
  key,
  label: key,
  sha: "3f2a1c0",
  at,
  pullRequest: null,
});

describe("checkpoints between the messages", () => {
  const rows = [
    you("ask-1", "2026-11-13T10:00:00.000Z"),
    agent("reply-1", "2026-11-13T10:00:05.000Z", "t-1"),
    you("ask-2", "2026-11-13T10:10:00.000Z"),
    agent("reply-2a", "2026-11-13T10:10:05.000Z", "t-2"),
    you("steer", "2026-11-13T10:11:00.000Z"),
    agent("reply-2b", "2026-11-13T10:11:05.000Z", "t-2"),
  ];

  it("follows its turn's last reply, before the next message", () => {
    const entries = withCheckpoints(rows, [
      mark(3, "2026-11-13T10:04:00.000Z", "t-1"),
      mark(5, "2026-11-13T10:15:00.000Z", "t-2"),
    ]);
    expect(shown(entries)).toEqual([
      "ask-1",
      "reply-1",
      "#3",
      "ask-2",
      "reply-2a",
      "steer",
      "reply-2b",
      "#5",
    ]);
  });

  it("follows its turn's reply even when a message sent meanwhile is older than it", () => {
    // ask-2 was sent while turn 1 ran, and waited for it.
    const queued = [rows[0], rows[1], you("ask-2", "2026-11-13T10:00:03.000Z")].filter(
      (row) => row !== undefined,
    );
    const entries = withCheckpoints(queued, [mark(3, "2026-11-13T10:04:00.000Z", "t-1")]);
    expect(shown(entries)).toEqual(["ask-1", "reply-1", "#3", "ask-2"]);
  });

  it("never comes before the first message held: that belongs to an earlier window", () => {
    const entries = withCheckpoints(rows.slice(2), [mark(1, "2026-11-13T09:59:00.000Z", "t-0")]);
    expect(shown(entries)).toEqual(["ask-2", "reply-2a", "steer", "reply-2b"]);
  });
});

describe("a message's time", () => {
  const now = new Date(2026, 10, 15, 16, 0);

  it("is the clock time today", () => {
    expect(messageTime(new Date(2026, 10, 15, 9, 5), now)).toBe("09:05");
  });

  it("names the day before today, and the year before this one", () => {
    expect(messageTime(new Date(2026, 10, 13, 10, 42), now)).toBe("13 Nov, 10:42");
    expect(messageTime(new Date(2025, 11, 30, 8, 0), now)).toBe("30 Dec 2025, 08:00");
  });
});

describe("landings between the messages", () => {
  const rows = [
    you("ask-1", "2026-11-13T10:00:00.000Z"),
    agent("reply-1", "2026-11-13T10:00:05.000Z", "t-1"),
    you("ask-2", "2026-11-13T10:10:00.000Z"),
  ];

  it("follows the checkpoint it landed, before the next message", () => {
    const entries = withLandings(
      withCheckpoints(rows, [mark(1, "2026-11-13T10:04:00.000Z", "t-1")]),
      [landed("landing:1", "2026-11-13T10:05:00.000Z")],
      true,
    );
    expect(shown(entries)).toEqual(["ask-1", "reply-1", "#1", "landing:1", "ask-2"]);
  });

  it("leaves a landing older than the held window to that window", () => {
    const entries = withLandings(
      withCheckpoints(rows.slice(2), []),
      [landed("landing:1", "2026-11-13T10:05:00.000Z")],
      false,
    );
    expect(shown(entries)).toEqual(["ask-2"]);
  });
});
