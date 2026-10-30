import { buildAgentConversation, type AgentTurnDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { conversationRows } from "./conversation-rows";
import { composeTurnInput } from "./turn-input";

const turn = (id: string, ordinal: number, input: string): AgentTurnDto => ({
  id,
  ordinal,
  input,
  status: "running",
  error: null,
  createdAt: `2026-09-27T10:00:0${ordinal}Z`,
});

const conversation = (...turns: ReadonlyArray<AgentTurnDto>) =>
  buildAgentConversation({ turns, items: [], requests: [] });

describe("conversationRows", () => {
  it("shows this phone's thumbnails on its own turn and reads others' images back as names", () => {
    const image = { name: "shot.jpg", path: "/h/paste/1.jpg", uri: "file:///shot.jpg" };
    const input = composeTurnInput("look", [image]);
    const own = conversationRows(conversation(turn("t1", 1, input)), new Map([["t1", [image]]]));
    expect(own[0]).toMatchObject({
      key: "turn:t1",
      view: { text: "look", images: [image] },
    });
    const elsewhere = conversationRows(conversation(turn("t1", 1, input)), new Map());
    expect(elsewhere[0]).toMatchObject({
      key: "turn:t1",
      view: { text: "look", images: [{ name: "shot.jpg", path: "/h/paste/1.jpg", uri: null }] },
    });
  });
});
