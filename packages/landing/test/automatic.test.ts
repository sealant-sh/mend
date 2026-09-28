import type { AgentTurnStatus } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  afterTheIntent,
  type ChangeFacts,
  type EndedTurnFacts,
  heldBack,
  planTurn,
  recordedIntent,
  withTheChange,
} from "../src/automatic.ts";

const facts = (
  overrides: Partial<Omit<EndedTurnFacts, "turn">> & {
    readonly turn?: Partial<EndedTurnFacts["turn"]>;
  } = {},
): EndedTurnFacts => ({
  changeOwnerUserId: "alice",
  sessionOwnerUserId: "alice",
  origin: "mend",
  on: true,
  pending: false,
  later: false,
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
  it("goes on to read the intent of the owner's completed turn", () => {
    expect(planTurn(facts())).toEqual({ _tag: "read-intent", on: true });
  });

  it.each<AgentTurnStatus>(["failed", "interrupted", "cancelled", "running", "queued"])(
    "never lands a %s turn, and says nothing about it",
    (status) => {
      expect(planTurn(facts({ turn: { status } }))).toEqual({
        _tag: "skipped",
        why: "not completed",
      });
    },
  );

  it("waits while the agent asks a question, or another turn is on its way", () => {
    expect(planTurn(facts({ pending: true }))).toEqual({
      _tag: "skipped",
      why: "waiting on the owner",
    });
    expect(planTurn(facts({ later: true }))).toEqual({
      _tag: "skipped",
      why: "a later turn decides",
    });
  });

  it("has nobody to land as when the change has no owner", () => {
    expect(planTurn(facts({ changeOwnerUserId: null }))).toEqual({
      _tag: "skipped",
      why: "no owner",
    });
  });

  it("does not land a follow-up someone else sent under shared control", () => {
    const notOwner = { _tag: "not-landed", reason: "not-owner" };
    expect(planTurn(facts({ turn: { author: "bob" } }))).toEqual(notOwner);
    // A turn Mend sent itself is not the owner's request either, even the opening one.
    expect(planTurn(facts({ turn: { author: null, ordinal: 0 } }))).toEqual(notOwner);
  });

  it("does not land a turn in a session a teammate started in the owner's worktree", () => {
    const notOwner = { _tag: "not-landed", reason: "not-owner" };
    // Bob's own turn in his session: the change is still Alice's.
    expect(planTurn(facts({ sessionOwnerUserId: "bob", turn: { author: "bob" } }))).toEqual(
      notOwner,
    );
    // Alice steering Bob's session under shared control: it would not be her session's turn.
    expect(planTurn(facts({ sessionOwnerUserId: "bob" }))).toEqual(notOwner);
  });

  it("with landing off, says nothing for a session run from the web or the CLI", () => {
    expect(planTurn(facts({ on: false }))).toEqual({
      _tag: "skipped",
      why: "automatic landing is off",
    });
  });

  it("with landing off, reads the owner's Slack request, and tells the thread about anyone else's", () => {
    expect(planTurn(facts({ on: false, origin: "slack" }))).toEqual({
      _tag: "read-intent",
      on: false,
    });
    expect(planTurn(facts({ on: false, origin: "slack", turn: { author: "bob" } }))).toEqual({
      _tag: "not-landed",
      reason: "off",
    });
  });

  it("names autopr=false as the reason, whatever the setting", () => {
    const optedOut = { intent: "question", intentSource: "option" } as const;
    expect(planTurn(facts({ on: false, turn: optedOut }))).toEqual({
      _tag: "not-landed",
      reason: "option",
    });
    expect(planTurn(facts({ turn: optedOut }))).toEqual({ _tag: "read-intent", on: true });
    expect(afterTheIntent({ intent: "question", source: "option" }, true)).toEqual({
      _tag: "not-landed",
      reason: "option",
    });
  });

  it("lands a change, and an unread request as a change; holds a question back", () => {
    const land = { _tag: "land", requested: false };
    expect(afterTheIntent({ intent: "change", source: "read" }, true)).toEqual(land);
    expect(afterTheIntent({ intent: "change", source: "option" }, true)).toEqual(land);
    expect(afterTheIntent({ intent: null, source: "unread" }, true)).toEqual(land);
    expect(afterTheIntent({ intent: "question", source: "read" }, true)).toEqual({
      _tag: "not-landed",
      reason: "question",
    });
  });

  it("lands a request to land, with automatic landing on or off; a change waits for it on", () => {
    const requested = { _tag: "land", requested: true };
    expect(afterTheIntent({ intent: "land", source: "read" }, true)).toEqual(requested);
    expect(afterTheIntent({ intent: "land", source: "read" }, false)).toEqual(requested);
    expect(afterTheIntent({ intent: "change", source: "read" }, false)).toEqual({
      _tag: "not-landed",
      reason: "off",
    });
    expect(afterTheIntent({ intent: "question", source: "read" }, false)).toEqual({
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
    expect(recordedIntent({ intent: "land", intentSource: "read" })).toEqual({
      intent: "land",
      source: "read",
    });
    expect(recordedIntent({ intent: null, intentSource: "unread" })).toEqual({
      intent: null,
      source: "unread",
    });
    expect(recordedIntent({ intent: null, intentSource: null })).toBeNull();
  });
});

const change = (overrides: Partial<ChangeFacts> = {}): ChangeFacts => ({
  captured: true,
  empty: false,
  newSinceLanding: true,
  ...overrides,
});

describe("the change a turn leaves (docs/adr/0007, amended 2026-09-27)", () => {
  const automatic = { _tag: "land", requested: false } as const;
  const requested = { _tag: "land", requested: true } as const;

  it("lands new work", () => {
    expect(withTheChange(automatic, change())).toEqual(automatic);
  });

  it("neither lands nor calls empty a change whose captures never caught up", () => {
    const stale = change({ captured: false, empty: true, newSinceLanding: false });
    expect(withTheChange(automatic, stale)).toEqual({ _tag: "not-landed", reason: "not-captured" });
    expect(withTheChange(requested, stale)).toEqual({ _tag: "not-landed", reason: "not-captured" });
  });

  it("says the change is empty, or that nothing is new since the last landing", () => {
    expect(withTheChange(automatic, change({ empty: true }))).toEqual({
      _tag: "not-landed",
      reason: "no-change",
    });
    expect(withTheChange(automatic, change({ newSinceLanding: false }))).toEqual({
      _tag: "not-landed",
      reason: "nothing-new",
    });
  });

  it("lets a request to land go on when nothing is new: the landing knows what is left", () => {
    expect(withTheChange(requested, change({ newSinceLanding: false }))).toEqual(requested);
    expect(withTheChange(requested, change({ empty: true }))).toEqual({
      _tag: "not-landed",
      reason: "no-change",
    });
  });

  it("states a reason that holds the change back only when there is something to land", () => {
    expect(heldBack("question", change())).toEqual({ _tag: "not-landed", reason: "question" });
    expect(heldBack("question", change({ empty: true }))).toEqual({
      _tag: "skipped",
      why: "nothing to land",
    });
    expect(heldBack("not-owner", change({ newSinceLanding: false }))).toEqual({
      _tag: "skipped",
      why: "nothing to land",
    });
  });
});
