import { describe, expect, it } from "vitest";

import { conversationWaitLine } from "./steering.ts";

describe("the waiting line (docs/adr/0016, decision 6)", () => {
  it("says what the previous sender's process still does, and whose turn waits", () => {
    expect(
      conversationWaitLine({
        runsAs: "Alice",
        sender: "Bob",
        openTurn: false,
        work: [{ kind: "task" }, { kind: "task" }, { kind: "sub-agent" }, { kind: "goal" }],
      }),
    ).toBe(
      "Waits for Alice's 2 background tasks, 1 sub-agent and a goal to finish before Bob's turn starts.",
    );
  });

  it("names a running turn, a terminal, a monitor and a wakeup", () => {
    expect(
      conversationWaitLine({
        runsAs: "Alice",
        sender: "Bob",
        openTurn: true,
        work: [{ kind: "terminal" }, { kind: "monitor" }, { kind: "wakeup" }],
      }),
    ).toBe(
      "Waits for Alice's turn, 1 background terminal, 1 monitor and 1 wakeup to finish before Bob's turn starts.",
    );
  });

  it("with only the settle left, waits for the agent", () => {
    expect(
      conversationWaitLine({ runsAs: "Alice", sender: "Bob", openTurn: false, work: [] }),
    ).toBe("Waits for Alice's agent to finish before Bob's turn starts.");
  });
});
