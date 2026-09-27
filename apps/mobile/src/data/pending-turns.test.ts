import { buildAgentConversation, type AgentTurnDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import {
  hasUnrecordedSend,
  pendingTurnsReducer,
  reconcileConversation,
  type PendingTurn,
  type PendingTurnEvent,
} from "./pending-turns";
import { composeTurnInput } from "./turn-input";

const run = (events: ReadonlyArray<PendingTurnEvent>, from: ReadonlyArray<PendingTurn> = []) =>
  events.reduce(pendingTurnsReducer, from);

const queued = (clientId: string, text: string): PendingTurnEvent => ({
  type: "queued",
  clientId,
  text,
  input: text,
  images: [],
});

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

describe("pendingTurnsReducer", () => {
  it("moves a send from sending to sent, and holds the recorded turn id", () => {
    const state = run([queued("c1", "hi"), { type: "delivered", clientId: "c1", turnId: "t1" }]);
    expect(state[0]).toMatchObject({ status: "sent", turnId: "t1", error: null });
  });

  it("marks a refused send, retries it, and discards only a failed one", () => {
    const failed = run([queued("c1", "hi"), { type: "failed", clientId: "c1", error: "offline" }]);
    expect(failed[0]).toMatchObject({ status: "failed", error: "offline" });
    const retried = run([{ type: "retried", clientId: "c1" }], failed);
    expect(retried[0]).toMatchObject({ status: "sending", error: null });
    expect(run([{ type: "discarded", clientId: "c1" }], retried)).toBe(retried);
    expect(run([{ type: "discarded", clientId: "c1" }], failed)).toEqual([]);
  });

  it("ignores a late answer for a send that already settled", () => {
    const sent = run([queued("c1", "hi"), { type: "delivered", clientId: "c1", turnId: "t1" }]);
    expect(run([{ type: "failed", clientId: "c1", error: "late" }], sent)).toBe(sent);
    expect(run([{ type: "delivered", clientId: "c1", turnId: "t9" }], sent)).toBe(sent);
  });
});

describe("reconcileConversation", () => {
  it("shows a send at once, at the end, before the server answers", () => {
    const rows = reconcileConversation(
      conversation(turn("t0", 0, "earlier")),
      run([queued("c1", "now")]),
    );
    expect(rows.map((row) => row.key)).toEqual(["turn:t0", "local:c1"]);
    expect(rows[1]).toMatchObject({ kind: "turn", view: { text: "now", delivery: "sending" } });
  });

  it("keeps showing a sent turn the conversation has not read back yet", () => {
    const pending = run([queued("c1", "now"), { type: "delivered", clientId: "c1", turnId: "t1" }]);
    const rows = reconcileConversation(conversation(turn("t0", 0, "earlier")), pending);
    expect(rows.map((row) => row.key)).toEqual(["turn:t0", "local:c1"]);
    expect(hasUnrecordedSend(conversation(turn("t0", 0, "earlier")), pending)).toBe(true);
  });

  it("swaps in the recorded turn under the same key, exactly once", () => {
    const pending = run([queued("c1", "now"), { type: "delivered", clientId: "c1", turnId: "t1" }]);
    const echoed = conversation(turn("t0", 0, "earlier"), turn("t1", 1, "now"));
    const rows = reconcileConversation(echoed, pending);
    expect(rows.map((row) => row.key)).toEqual(["turn:t0", "local:c1"]);
    expect(rows[1]).toMatchObject({
      view: { text: "now", delivery: "recorded", clientId: "c1", turn: { id: "t1" } },
    });
    expect(hasUnrecordedSend(echoed, pending)).toBe(false);
  });

  it("never matches by text: the same words sent twice stay two turns", () => {
    const pending = run([
      queued("c1", "again"),
      { type: "delivered", clientId: "c1", turnId: "t1" },
      queued("c2", "again"),
    ]);
    const rows = reconcileConversation(conversation(turn("t1", 1, "again")), pending);
    expect(rows.map((row) => row.key)).toEqual(["local:c1", "local:c2"]);
    expect(rows.map((row) => (row.kind === "turn" ? row.view.delivery : null))).toEqual([
      "recorded",
      "sending",
    ]);
    // Someone else's turn with the same words is not taken for this phone's send.
    const other = reconcileConversation(
      conversation(turn("t7", 1, "again")),
      run([queued("c3", "again")]),
    );
    expect(other.map((row) => row.key)).toEqual(["turn:t7", "local:c3"]);
  });

  it("keeps sends in the order they were made while none is recorded", () => {
    const pending = run([queued("c1", "one"), queued("c2", "two"), queued("c3", "three")]);
    const rows = reconcileConversation(conversation(), pending);
    expect(rows.map((row) => row.key)).toEqual(["local:c1", "local:c2", "local:c3"]);
  });

  it("leaves a failed send in place with its error", () => {
    const pending = run([
      queued("c1", "one"),
      { type: "failed", clientId: "c1", error: "Session is not live" },
    ]);
    const rows = reconcileConversation(conversation(turn("t0", 0, "earlier")), pending);
    expect(rows[1]).toMatchObject({
      key: "local:c1",
      view: { delivery: "failed", error: "Session is not live", clientId: "c1" },
    });
    expect(hasUnrecordedSend(conversation(), pending)).toBe(false);
  });

  it("keeps this phone's thumbnails on the recorded turn and reads others' back as names", () => {
    const image = { name: "shot.jpg", path: "/h/paste/1.jpg", uri: "file:///shot.jpg" };
    const input = composeTurnInput("look", [image]);
    const pending = run([
      { type: "queued", clientId: "c1", text: "look", input, images: [image] },
      { type: "delivered", clientId: "c1", turnId: "t1" },
    ]);
    const before = reconcileConversation(conversation(), pending);
    const after = reconcileConversation(conversation(turn("t1", 1, input)), pending);
    const views = [before[0], after[0]].map((row) => (row?.kind === "turn" ? row.view : null));
    expect(views.map((view) => view?.text)).toEqual(["look", "look"]);
    expect(views.map((view) => view?.images)).toEqual([
      [{ name: "shot.jpg", path: "/h/paste/1.jpg", uri: "file:///shot.jpg" }],
      [{ name: "shot.jpg", path: "/h/paste/1.jpg", uri: "file:///shot.jpg" }],
    ]);
    const elsewhere = reconcileConversation(conversation(turn("t1", 1, input)), []);
    expect(elsewhere[0]).toMatchObject({
      key: "turn:t1",
      view: { text: "look", images: [{ name: "shot.jpg", path: "/h/paste/1.jpg", uri: null }] },
    });
  });
});

describe("reconcileConversation · order", () => {
  it("keeps a failed send above the message sent after it", () => {
    const pending = run([
      queued("c1", "one"),
      { type: "failed", clientId: "c1", error: "offline" },
      queued("c2", "two"),
      { type: "delivered", clientId: "c2", turnId: "t2" },
    ]);
    const rows = reconcileConversation(
      conversation(turn("t0", 0, "earlier"), turn("t2", 1, "two")),
      pending,
    );
    expect(rows.map((row) => row.key)).toEqual(["turn:t0", "local:c1", "local:c2"]);
  });
});
