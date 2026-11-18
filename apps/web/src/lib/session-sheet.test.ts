import { describe, expect, it } from "vitest";

import type { ConversationRow } from "./conversation-rows.ts";
import { messageTime, withCheckpoints } from "./session-sheet.ts";

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

const agent = (key: string, at: string): ConversationRow => ({
  kind: "agent",
  key,
  turn: null,
  at,
  open: false,
  segments: [],
  folded: [],
});

const checkpoint = (ordinal: number, at: string, sessionId = "s-1") => ({
  ordinal,
  sessionId,
  sha: `${ordinal}abcdef0123`,
  createdAt: new Date(at),
});

const shown = (entries: ReturnType<typeof withCheckpoints>) =>
  entries.map((entry) => (entry.kind === "row" ? entry.row.key : `#${entry.mark.ordinal}`));

describe("checkpoints between the messages", () => {
  const rows = [
    you("ask-1", "2026-11-13T10:00:00.000Z"),
    agent("reply-1", "2026-11-13T10:00:05.000Z"),
    you("ask-2", "2026-11-13T10:10:00.000Z"),
    agent("reply-2", "2026-11-13T10:10:05.000Z"),
  ];

  it("follows the reply of the turn it was taken in, before the next message", () => {
    const entries = withCheckpoints(
      rows,
      [checkpoint(1, "2026-11-13T10:04:00.000Z"), checkpoint(2, "2026-11-13T10:15:00.000Z")],
      "s-1",
      true,
    );
    expect(shown(entries)).toEqual(["ask-1", "reply-1", "#1", "ask-2", "reply-2", "#2"]);
  });

  it("leaves out the worktree's start and another session's checkpoints", () => {
    const entries = withCheckpoints(
      rows,
      [
        checkpoint(0, "2026-11-13T09:59:00.000Z"),
        checkpoint(1, "2026-11-13T10:04:00.000Z", "s-2"),
        checkpoint(2, "2026-11-13T10:15:00.000Z"),
      ],
      "s-1",
      true,
    );
    expect(shown(entries)).toEqual(["ask-1", "reply-1", "ask-2", "reply-2", "#2"]);
  });

  it("leaves a checkpoint older than the held window to that window", () => {
    const newest = rows.slice(2);
    const entries = withCheckpoints(
      newest,
      [checkpoint(1, "2026-11-13T10:04:00.000Z"), checkpoint(2, "2026-11-13T10:15:00.000Z")],
      "s-1",
      false,
    );
    expect(shown(entries)).toEqual(["ask-2", "reply-2", "#2"]);
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
