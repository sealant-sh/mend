// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { readDraft, writeDrafts } from "./drafts.ts";
import {
  type Courier,
  draftItems,
  holdUntilStarted,
  type MessageRequest,
  moveMessages,
  readOutbox,
  sendWaiting,
  waitingMessages,
} from "./outbox.ts";

beforeEach(() => sessionStorage.clear());

const scope = { userId: "ada", sessionId: "s-1" };

/** A courier whose every send is lost on the way, keeping what it was asked to send. */
const lostCourier = (sent: Array<MessageRequest>): Courier => ({
  queryClient: new QueryClient(),
  send: (request) => {
    sent.push(request);
    return Promise.reject(new Error("The connection dropped."));
  },
  conversation: () => undefined,
  answered: () => undefined,
});

describe("messages written while a session starts", () => {
  it("wait in the outbox, in order, until the agent runs; nothing leaves", () => {
    holdUntilStarted(scope, "Also cover partial refunds.", "k-1");
    holdUntilStarted(scope, "And the tests.", "k-2");
    expect(waitingMessages(scope).map((message) => [message.text, message.state._tag])).toEqual([
      ["Also cover partial refunds.", "Waiting"],
      ["And the tests.", "Waiting"],
    ]);
  });

  it("go once the agent runs, oldest first, each under the key it was written with", async () => {
    holdUntilStarted(scope, "First.", "k-1");
    holdUntilStarted(scope, "Second.", "k-2");
    const sent: Array<MessageRequest> = [];
    await sendWaiting(lostCourier(sent), scope);
    expect(sent.map((request) => [request.input, request.clientMessageId])).toEqual([
      ["First.", "k-1"],
      ["Second.", "k-2"],
    ]);
    expect(waitingMessages(scope)).toEqual([]);
    // Each was sent: with no answer, each reads as unconfirmed, never as still waiting.
    expect(readOutbox(scope).map((message) => message.state._tag)).toEqual([
      "Unconfirmed",
      "Unconfirmed",
    ]);
  });
});

describe("a start's messages moving onto the session Mend made", () => {
  const draft = { userId: "ada", sessionId: "draft-1" };

  it("carries the waiting messages and the unsent words, and leaves nothing under the draft", () => {
    holdUntilStarted(draft, "Also cover partial refunds.", "k-1");
    const before = draftItems(draft);
    writeDrafts([
      [before.text, "Half a thought"],
      [before.key, "k-2"],
    ]);
    moveMessages(draft, scope);
    expect(waitingMessages(scope).map((message) => message.clientMessageId)).toEqual(["k-1"]);
    expect(readOutbox(draft)).toEqual([]);
    expect(readDraft(draftItems(scope).text)).toBe("Half a thought");
    expect(readDraft(draftItems(scope).key)).toBe("k-2");
    expect(readDraft(before.text)).toBe("");
  });

  it("joins words already written on the session, as a new message", () => {
    writeDrafts([
      [draftItems(scope).text, "Already here"],
      [draftItems(scope).key, "k-9"],
      [draftItems(draft).text, "From the start page"],
    ]);
    moveMessages(draft, scope);
    expect(readDraft(draftItems(scope).text)).toBe("Already here\n\nFrom the start page");
    expect(readDraft(draftItems(scope).key)).toBe("");
  });
});
