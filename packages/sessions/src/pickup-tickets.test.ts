import { describe, expect, it } from "vitest";

import {
  PICKUP_TICKET_TTL_MS,
  makePickupTickets,
  pickupChannelMatch,
  pickupSiblingMatch,
  type PickupBinding,
  type PickupChannel,
} from "./pickup-tickets.ts";

const binding: PickupBinding = {
  purpose: "secret-files",
  sessionId: "sess-alice",
  worktreeId: "wt-1",
  personId: "alice",
  launchId: "launch-1",
};
const files = [{ path: ".npmrc", bytes: new TextEncoder().encode("token") }];

const channel = (over: Partial<PickupChannel>): PickupChannel => ({
  sessionId: "sess-alice",
  launchId: null,
  accountId: null,
  ...over,
});

describe("pickup tickets", () => {
  it("answer once; a second presentation reads as spent until the backstop, then as unknown", () => {
    let now = 1_000;
    const tickets = makePickupTickets({ now: () => now });
    const ticket = tickets.mint(binding, files);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tickets.take(ticket)).toEqual({ kind: "taken", entry: { binding, files } });
    expect(tickets.take(ticket)).toEqual({ kind: "spent", binding });
    now += PICKUP_TICKET_TTL_MS;
    expect(tickets.take(ticket)).toEqual({ kind: "unknown" });
  });

  it("live through a long wait for an exec slot: the backstop is minutes, not seconds", () => {
    let now = 0;
    const tickets = makePickupTickets({ now: () => now });
    const ticket = tickets.mint(binding, files);
    // Core's run-exec queue may hold an exec behind installs for minutes (review of mend#555, P2-1).
    now += 5 * 60_000;
    expect(tickets.take(ticket).kind).toBe("taken");
    expect(PICKUP_TICKET_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("die when their exec ends, redeemed or not, and a discarded one never answers", () => {
    const tickets = makePickupTickets();
    const ticket = tickets.mint(binding, files);
    tickets.discard(ticket);
    expect(tickets.size()).toBe(0);
    expect(tickets.take(ticket)).toEqual({ kind: "unknown" });
  });

  it("never look up what is not a ticket's shape", () => {
    const tickets = makePickupTickets();
    tickets.mint(binding, files);
    expect(tickets.take("short")).toEqual({ kind: "unknown" });
    expect(tickets.take(`${"a".repeat(42)}!`)).toEqual({ kind: "unknown" });
    expect(tickets.size()).toBe(1);
  });
});

describe("who may redeem", () => {
  it("the executor's own launch, through the workspace's token", () => {
    expect(pickupChannelMatch(binding, channel({ launchId: "launch-1" }))).toEqual({ kind: "yes" });
  });

  it("never another executor's launch", () => {
    expect(pickupChannelMatch(binding, channel({ launchId: "launch-2" }))).toEqual({
      kind: "no",
      reason: "this pickup ticket is another executor's",
    });
  });

  it("a person's token only for that person's ticket, even in the right launch", () => {
    expect(
      pickupChannelMatch(binding, channel({ launchId: "launch-1", accountId: "alice" })),
    ).toEqual({ kind: "yes" });
    expect(
      pickupChannelMatch(binding, channel({ launchId: "launch-1", accountId: "maria" })),
    ).toEqual({ kind: "no", reason: "this pickup ticket is another person's" });
    expect(
      pickupChannelMatch({ ...binding, personId: null }, channel({ accountId: "maria" })),
    ).toEqual({ kind: "no", reason: "this pickup ticket is another person's" });
  });

  it("over the socket, the ticket's own session; another session is asked about", () => {
    expect(pickupChannelMatch(binding, channel({}))).toEqual({ kind: "yes" });
    expect(pickupChannelMatch(binding, channel({ sessionId: "sess-sibling" }))).toEqual({
      kind: "ask",
    });
    expect(
      pickupChannelMatch({ ...binding, launchId: null }, channel({ launchId: "launch-1" })),
    ).toEqual({ kind: "yes" });
  });

  it("a sibling only in the same worktree with the same owner", () => {
    expect(pickupSiblingMatch(binding, { worktreeId: "wt-1", ownerUserId: "alice" })).toBe(true);
    expect(pickupSiblingMatch(binding, { worktreeId: "wt-1", ownerUserId: "maria" })).toBe(false);
    expect(pickupSiblingMatch(binding, { worktreeId: "wt-2", ownerUserId: "alice" })).toBe(false);
    expect(pickupSiblingMatch(binding, null)).toBe(false);
    expect(
      pickupSiblingMatch({ ...binding, personId: null }, { worktreeId: "wt-1", ownerUserId: null }),
    ).toBe(false);
  });
});

describe("putting a taken ticket back (review 4 of mend#553, P3-1)", () => {
  it("makes a ticket whose answer failed redeemable once more, and never one its exec has discarded", () => {
    const tickets = makePickupTickets();
    const ticket = tickets.mint(binding, files);
    const taken = tickets.take(ticket);
    if (taken.kind !== "taken") throw new Error("not taken");
    // The answer failed: back it goes, and the retry takes it.
    expect(tickets.restore(ticket, taken.entry)).toBe(true);
    expect(tickets.take(ticket).kind).toBe("taken");
    // Once its exec has ended, nothing puts it back, and a late presentation still reads spent.
    tickets.discard(ticket);
    expect(tickets.restore(ticket, taken.entry)).toBe(false);
    expect(tickets.take(ticket).kind).toBe("spent");
    // A ticket never taken cannot be "put back" into existence.
    expect(tickets.restore("x".repeat(43), taken.entry)).toBe(false);
  });
});
