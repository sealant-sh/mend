import { describe, expect, it } from "vitest";

import { notificationRecipients } from "./notification-recipients.ts";

describe("notification recipients (docs/adr/0003)", () => {
  it("reaches the session owner only", () => {
    expect([
      ...notificationRecipients({
        ownerUserId: "alice",
        sharedControl: false,
        latestTurnSenderUserId: "carol",
      }),
    ]).toEqual(["alice"]);
  });

  it("adds the latest turn's sender when the owner shares control", () => {
    expect([
      ...notificationRecipients({
        ownerUserId: "alice",
        sharedControl: true,
        latestTurnSenderUserId: "carol",
      }),
    ]).toEqual(["alice", "carol"]);
    expect([
      ...notificationRecipients({
        ownerUserId: "alice",
        sharedControl: true,
        latestTurnSenderUserId: "alice",
      }),
    ]).toEqual(["alice"]);
  });

  it("reaches nobody for a session without an owner", () => {
    expect(
      notificationRecipients({
        ownerUserId: null,
        sharedControl: true,
        latestTurnSenderUserId: "x",
      }).size,
    ).toBe(0);
  });
});
