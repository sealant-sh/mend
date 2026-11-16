import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { type FirstMessageLaunch, sendFirstMessage, takesFirstMessage } from "./first-message.ts";
import { refusedWith } from "./refusal-fixture.ts";

const waiting = { importedConversationWaiting: true };

describe("takesFirstMessage", () => {
  it.each([
    ["an imported session waiting, steered by this viewer", waiting, null, true, true],
    ["a viewer who does not steer it", waiting, null, false, false],
    ["a session an agent already ran in", waiting, { kind: "agent-protocol" }, true, false],
    [
      "a session holding no imported conversation",
      { ...waiting, importedConversationWaiting: false },
      null,
      true,
      false,
    ],
  ] as const)("%s", (_what, session, currentAgent, steer, takes) => {
    expect(takesFirstMessage(session, currentAgent, steer)).toBe(takes);
  });
});

describe("sendFirstMessage", () => {
  it("starts the agent in conversation mode with the words as its first turn, over an attempt that never ran", async () => {
    const sent: Array<FirstMessageLaunch> = [];
    const outcome = await sendFirstMessage(async (request) => {
      sent.push(request);
      return {};
    }, "Carry on with the cart total");
    expect(outcome).toEqual({ _tag: "Started" });
    expect(sent).toEqual([
      { mode: "protocol", prompt: "Carry on with the cart total", expected: { settledAt: null } },
    ]);
  });

  it.each([
    [
      "someone else started it first",
      "SessionMovedOn",
      "Another launch of this session is under way.",
    ],
    [
      "a launch slot is taken",
      "BudgetExceeded",
      "Every launch slot is in use. Try again when one ends.",
    ],
  ])("says the server's words when %s", async (_what, tag, words) => {
    const outcome = await sendFirstMessage(() => Promise.reject(refusedWith(tag, words)), "Go on");
    expect(outcome).toEqual({ _tag: "Refused", words });
  });

  it("calls a lost answer unconfirmed, since the agent may be starting", async () => {
    const outcome = await sendFirstMessage(
      () => Promise.reject(new TRPCClientError("The Mend server is not answering.")),
      "Go on",
    );
    expect(outcome).toEqual({ _tag: "Unconfirmed" });
  });
});
