import type { AgentTurnStatus } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  afterTheIntent,
  beforeTheChange,
  type EndedTurnFacts,
  recordedIntent,
} from "../src/automatic.ts";

const facts = (
  overrides: Partial<Omit<EndedTurnFacts, "turn">> & {
    readonly turn?: Partial<EndedTurnFacts["turn"]>;
  } = {},
): EndedTurnFacts => ({
  ownerUserId: "alice",
  origin: "mend",
  on: true,
  pending: false,
  later: false,
  opening: false,
  ...overrides,
  turn: {
    status: "completed",
    author: "alice",
    ordinal: 1,
    intent: null,
    intentSource: null,
    ...overrides.turn,
  },
});

describe("when a completed turn lands (docs/adr/0007, Automatic landing)", () => {
  it("goes on to read the change for the owner's completed turn, and then the intent", () => {
    expect(beforeTheChange(facts())).toEqual({ _tag: "check-change", next: "read-intent" });
  });

  it.each<AgentTurnStatus>(["failed", "interrupted", "cancelled", "running", "queued"])(
    "never lands a %s turn, and says nothing about it",
    (status) => {
      expect(beforeTheChange(facts({ turn: { status } }))).toEqual({ _tag: "skipped" });
    },
  );

  it("waits while the agent asks a question, or another turn is on its way", () => {
    expect(beforeTheChange(facts({ pending: true }))).toEqual({ _tag: "skipped" });
    expect(beforeTheChange(facts({ later: true }))).toEqual({ _tag: "skipped" });
  });

  it("has nobody to land as without an owner", () => {
    expect(beforeTheChange(facts({ ownerUserId: null }))).toEqual({ _tag: "skipped" });
  });

  it("does not land a follow-up someone else sent under shared control", () => {
    expect(beforeTheChange(facts({ turn: { author: "bob" } }))).toEqual({
      _tag: "check-change",
      next: "not-owner",
    });
    // A turn Mend sent itself is not the owner's request either.
    expect(beforeTheChange(facts({ turn: { author: null } }))).toEqual({
      _tag: "check-change",
      next: "not-owner",
    });
  });

  it("takes the session's opening request as the owner's own", () => {
    expect(beforeTheChange(facts({ opening: true, turn: { author: null } }))).toEqual({
      _tag: "check-change",
      next: "read-intent",
    });
  });

  it("with landing off, says nothing for a session run from the web or the CLI", () => {
    expect(beforeTheChange(facts({ on: false }))).toEqual({ _tag: "skipped" });
  });

  it("with landing off, tells a Slack thread why, so it can offer the button", () => {
    expect(beforeTheChange(facts({ on: false, origin: "slack" }))).toEqual({
      _tag: "check-change",
      next: "off",
    });
  });

  it("names autopr=false as the reason, whatever the setting", () => {
    const optedOut = { intent: "question", intentSource: "option" } as const;
    expect(beforeTheChange(facts({ on: false, turn: optedOut }))).toEqual({
      _tag: "check-change",
      next: "option",
    });
    expect(beforeTheChange(facts({ turn: optedOut }))).toEqual({
      _tag: "check-change",
      next: "read-intent",
    });
    expect(afterTheIntent({ intent: "question", source: "option" })).toEqual({
      _tag: "not-landed",
      reason: "option",
    });
  });

  it("lands a change, and an unread request as a change; holds a question back", () => {
    expect(afterTheIntent({ intent: "change", source: "read" })).toEqual({ _tag: "land" });
    expect(afterTheIntent({ intent: "change", source: "option" })).toEqual({ _tag: "land" });
    expect(afterTheIntent({ intent: null, source: "unread" })).toEqual({ _tag: "land" });
    expect(afterTheIntent({ intent: "question", source: "read" })).toEqual({
      _tag: "not-landed",
      reason: "question",
    });
  });

  it("reuses a reading made before the turn ended, and asks for one otherwise", () => {
    expect(recordedIntent({ intent: "question", intentSource: "read" })).toEqual({
      intent: "question",
      source: "read",
    });
    expect(recordedIntent({ intent: "change", intentSource: "option" })).toEqual({
      intent: "change",
      source: "option",
    });
    expect(recordedIntent({ intent: null, intentSource: "unread" })).toEqual({
      intent: null,
      source: "unread",
    });
    expect(recordedIntent({ intent: null, intentSource: null })).toBeNull();
  });
});
