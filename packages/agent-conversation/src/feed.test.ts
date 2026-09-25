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

  it("builds on runtimes without change-array-by-copy methods", () => {
    const legacyTurns = new Proxy(conversation.turns, {
      get: (target, property, receiver) =>
        property === "toSorted" ? undefined : Reflect.get(target, property, receiver),
    });
    expect(() => buildAgentConversation({ ...conversation, turns: legacyTurns })).not.toThrow();
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
    expect(openTurnOf(conversation.turns)?.id).toBe("turn-2");
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

  it("reads on from the highest item sequence held", () => {
    expect(latestItemSeq(conversation.items)).toBe(3);
    expect(latestItemSeq([])).toBe(0);
  });
});
