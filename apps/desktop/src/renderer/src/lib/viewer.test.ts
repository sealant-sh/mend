import { describe, expect, it } from "vitest";

import { sessionFixture } from "#/lib/fixtures";
import { readOnlyActions, steererActions } from "#/lib/services";
import { sessionActions } from "#/lib/viewer";

const owned = sessionFixture({ ownerUserId: "alice" });
const shared = sessionFixture({
  ownerUserId: "alice",
  sharedControlEnabledByUserId: "alice",
  sharedControlEnabledAt: "2026-09-24T00:00:00.000Z",
});
const alice = { userId: "alice", role: "member" } as const;
const bob = { userId: "bob", role: "owner" } as const;
const carol = { userId: "carol", role: "member" } as const;

describe("sessionActions", () => {
  it("gives the owner everything and an organization owner only stop", () => {
    expect(sessionActions(owned, alice)).toEqual({
      own: true,
      steer: true,
      stop: true,
      terminalInput: true,
    });
    expect(sessionActions(owned, bob)).toEqual({
      own: false,
      steer: false,
      stop: true,
      terminalInput: false,
    });
    expect(sessionActions(owned, carol)).toEqual({
      own: false,
      steer: false,
      stop: false,
      terminalInput: false,
    });
  });

  it("lets everyone steer while control is shared, and keeps delete and the terminal the owner's", () => {
    expect(sessionActions(shared, carol)).toEqual({
      own: false,
      steer: true,
      stop: true,
      terminalInput: false,
    });
    expect(sessionActions(shared, alice).terminalInput).toBe(true);
  });

  it("offers nothing to an unknown viewer or on a session nobody owns", () => {
    expect(sessionActions(owned, null)).toEqual({
      own: false,
      steer: false,
      stop: false,
      terminalInput: false,
    });
    expect(sessionActions(sessionFixture({ ownerUserId: null }), alice)).toEqual({
      own: false,
      steer: false,
      stop: false,
      terminalInput: false,
    });
  });
});

describe("readOnlyActions", () => {
  it("keeps reading and drops every action that runs something", () => {
    expect(
      readOnlyActions(["open", "copy", "logs", "restart", "stop", "remove-forward", "run-again"]),
    ).toEqual(["open", "copy", "logs"]);
  });
});

describe("steererActions", () => {
  it("leaves a steerer restart and stop, and running a command again to the owner", () => {
    expect(steererActions(["open", "logs", "restart", "stop", "run-again"])).toEqual([
      "open",
      "logs",
      "restart",
      "stop",
    ]);
  });
});
