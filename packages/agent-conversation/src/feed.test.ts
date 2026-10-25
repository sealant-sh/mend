import { describe, expect, it } from "vitest";

import {
  buildAgentConversation,
  conversationActivity,
  latestItemSeq,
  mergeAgentItems,
  openTurnOf,
  type AgentConversationDto,
} from "./feed.ts";

const conversation: AgentConversationDto = {
  turns: [
    {
      id: "turn-2",
      ordinal: 2,
      input: "second",
      status: "running",
      error: null,
      createdAt: "2026-08-21T10:00:02.000Z",
    },
    {
      id: "turn-1",
      ordinal: 1,
      input: "first",
      status: "completed",
      error: null,
      createdAt: "2026-08-21T10:00:00.000Z",
    },
  ],
  items: [
    {
      id: "assistant-1",
      seq: 2,
      turnId: "turn-1",
      kind: "assistant-message",
      status: "completed",
      title: null,
      text: "done",
      createdAt: "2026-08-21T10:00:01.000Z",
      updatedAt: "2026-08-21T10:00:01.000Z",
    },
    {
      id: "user-copy",
      seq: 1,
      turnId: "turn-1",
      kind: "user-message",
      status: "completed",
      title: null,
      text: "first",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
    },
    {
      id: "orphan-warning",
      seq: 3,
      turnId: "missing-turn",
      kind: "error",
      status: "failed",
      title: "warning",
      text: null,
      createdAt: "2026-08-21T10:00:03.000Z",
      updatedAt: "2026-08-21T10:00:03.000Z",
    },
  ],
  requests: [
    {
      id: "request-1",
      turnId: "turn-1",
      kind: "command-approval",
      title: null,
      detail: null,
      questions: null,
      status: "pending",
      decision: null,
      answers: null,
      createdAt: "2026-08-21T10:00:00.500Z",
    },
  ],
};

describe("buildAgentConversation", () => {
  it("orders by authored turn, interleaves child events, and removes duplicate user items", () => {
    expect(buildAgentConversation(conversation).map((entry) => entry.key)).toEqual([
      "turn:turn-1",
      "request:request-1",
      "item:assistant-1",
      "turn:turn-2",
      "item:orphan-warning",
    ]);
  });

  it("interleaves saved steers, preserves delivery evidence and hides provider echoes", () => {
    const first = conversation.turns.find((turn) => turn.id === "turn-1");
    if (first === undefined) throw new Error("missing turn");
    const deliveries = [
      { _tag: "Sending" },
      { _tag: "Accepted", evidence: "provider-acknowledged" },
      { _tag: "Accepted", evidence: "transport-written" },
      { _tag: "Unknown", reason: "restart" },
      { _tag: "NotSent", reason: "turn-ended", message: "Your words are saved." },
    ] as const;
    for (const delivery of deliveries) {
      const steer = {
        id: "steer-1",
        turnId: first.id,
        ordinal: 0,
        author: "alice",
        input: "Keep the shape",
        createdAt: "2026-08-21T10:00:00.700Z",
        delivery,
      };
      const entries = buildAgentConversation({
        ...conversation,
        turns: [{ ...first, steers: [steer] }],
      });
      expect(entries.map((entry) => entry.key)).toEqual([
        "turn:turn-1",
        "request:request-1",
        "steer:steer-1",
        "item:assistant-1",
        "item:orphan-warning",
      ]);
      expect(entries.find((entry) => entry.kind === "steer")).toEqual({
        kind: "steer",
        key: "steer:steer-1",
        steer,
      });
    }
  });

  it("renders a carried steer once, as a turn marked with its steer origin", () => {
    const first = conversation.turns.find((turn) => turn.id === "turn-1");
    if (first === undefined) throw new Error("missing turn");
    const steer = {
      id: "carried",
      turnId: first.id,
      ordinal: 0,
      author: "alice",
      input: "next words",
      createdAt: "2026-08-21T10:00:01.500Z",
      delivery: { _tag: "Queued", turnId: "next", reason: "turn-ended" } as const,
    };
    const next = {
      ...first,
      id: "next",
      ordinal: 3,
      input: steer.input,
      status: "queued",
      fromSteer: steer.id,
    };
    const entries = buildAgentConversation({
      ...conversation,
      turns: [{ ...first, steers: [steer] }, next],
    });
    expect(entries.filter((entry) => entry.kind === "steer")).toEqual([]);
    expect(entries.find((entry) => entry.key === "turn:next")).toEqual({
      kind: "turn",
      key: "turn:next",
      turn: next,
    });
  });

  it("replaces cursor updates in place and appends new items", () => {
    const original = conversation.items.find((item) => item.id === "assistant-1");
    const seed = conversation.items.find((item) => item.id === "orphan-warning");
    if (original === undefined || seed === undefined) {
      throw new Error("test conversation is missing its item fixtures");
    }
    const updated = { ...original, seq: 4, text: "done now" };
    const added = { ...seed, id: "later", seq: 5 };
    expect(mergeAgentItems([original], [updated, added])).toEqual([updated, added]);
  });
});

describe("conversation activity", () => {
  it("names the newest open turn as what Stop interrupts", () => {
    const base = conversation.turns[0];
    if (base === undefined) throw new Error("Expected a turn fixture.");
    const older = { ...base, id: "older", ordinal: 1, status: "running" };
    const newer = { ...base, id: "newer", ordinal: 2, status: "queued" };
    const finished = { ...base, id: "finished", ordinal: 3, status: "completed" };
    const ordered = [older, newer, finished];
    expect(openTurnOf(ordered)?.id).toBe("newer");
    expect(openTurnOf(ordered.slice(0, 1))?.id).toBe("older");
    expect(openTurnOf(conversation.turns.filter((turn) => turn.id === "turn-1"))).toBeUndefined();
  });

  it("says the agent waits on a person before it says it works", () => {
    expect(conversationActivity(conversation)).toBe("waiting");
    expect(conversationActivity({ ...conversation, requests: [] })).toBe("working");
    expect(
      conversationActivity({
        ...conversation,
        requests: [],
        turns: conversation.turns.map((turn) => ({ ...turn, status: "completed" })),
      }),
    ).toBeNull();
  });

  it("says the agent works while a workflow runs after its turn ended", () => {
    const ended = {
      ...conversation,
      requests: [],
      turns: conversation.turns.map((turn) => ({ ...turn, status: "completed" })),
    };
    const workflow = {
      id: "item-task",
      seq: 9,
      turnId: "turn-1",
      kind: "task",
      status: "in-progress",
      title: "Workflow review",
      text: null,
      createdAt: "2026-08-21T10:00:03.000Z",
      updatedAt: "2026-08-21T10:00:09.000Z",
    };
    expect(conversationActivity({ ...ended, items: [...ended.items, workflow] })).toBe("working");
    expect(
      conversationActivity({
        ...ended,
        items: [...ended.items, { ...workflow, status: "completed" }],
      }),
    ).toBeNull();
  });

  it("reads on from the highest item sequence held", () => {
    expect(latestItemSeq(conversation.items)).toBe(3);
    expect(latestItemSeq([])).toBe(0);
  });
});
