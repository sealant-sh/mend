// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { readDraft, writeDrafts } from "./drafts.ts";
import {
  type Courier,
  draftItems,
  holdForStart,
  type MessageRequest,
  moveMessages,
  parseOutbox,
  readOutbox,
  sendHeld,
  shownOutbox,
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

describe("words written on a start's page before Mend made the session", () => {
  it("show at once as on their way, in order", () => {
    holdForStart(scope, "Also cover partial refunds.", "k-1");
    holdForStart(scope, "And the tests.", "k-2");
    expect(
      shownOutbox(readOutbox(scope)).map((message) => [message.text, message.state._tag]),
    ).toEqual([
      ["Also cover partial refunds.", "Sending"],
      ["And the tests.", "Sending"],
    ]);
  });

  it("go once the session exists, oldest first, each under the key it was written with", async () => {
    holdForStart(scope, "First.", "k-1");
    holdForStart(scope, "Second.", "k-2");
    const sent: Array<MessageRequest> = [];
    await sendHeld(lostCourier(sent), scope, readOutbox(scope));
    expect(sent.map((request) => [request.input, request.clientMessageId])).toEqual([
      ["First.", "k-1"],
      ["Second.", "k-2"],
    ]);
    // Each was sent: with no answer, each reads as unconfirmed.
    expect(readOutbox(scope).map((message) => message.state._tag)).toEqual([
      "Unconfirmed",
      "Unconfirmed",
    ]);
  });

  it("reads a message an earlier page kept waiting as unconfirmed, never drops it", () => {
    const stored = JSON.stringify([
      {
        clientMessageId: "k-old",
        text: "Kept by the old page.",
        sentAt: "2026-11-20T10:00:00Z",
        state: { _tag: "Waiting" },
      },
    ]);
    expect(parseOutbox(stored).map((message) => [message.text, message.state._tag])).toEqual([
      ["Kept by the old page.", "Unconfirmed"],
    ]);
  });
});

describe("a start's messages moving onto the session Mend made", () => {
  const draft = { userId: "ada", sessionId: "draft-1" };

  it("carries the held messages and the unsent words, and leaves nothing under the draft", () => {
    holdForStart(draft, "Also cover partial refunds.", "k-1");
    const before = draftItems(draft);
    writeDrafts([
      [before.text, "Half a thought"],
      [before.key, "k-2"],
    ]);
    moveMessages(draft, scope);
    expect(readOutbox(scope).map((message) => message.clientMessageId)).toEqual(["k-1"]);
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
