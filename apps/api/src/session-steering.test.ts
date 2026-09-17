import { describe, expect, it } from "vitest";

import { canSteerSession } from "./session-steering.ts";

describe("canSteerSession", () => {
  it("allows the explicit owner", () => {
    expect(
      canSteerSession({
        ownerUserId: "alice",
        callerUserId: "alice",
        fallbackOwnerUserId: "bob",
      }),
    ).toBe(true);
  });

  it("refuses a caller who is not the explicit owner", () => {
    expect(
      canSteerSession({
        ownerUserId: "alice",
        callerUserId: "bob",
        fallbackOwnerUserId: "bob",
      }),
    ).toBe(false);
  });

  it("allows the fallback owner when the stored owner is null", () => {
    expect(
      canSteerSession({
        ownerUserId: null,
        callerUserId: "alice",
        fallbackOwnerUserId: "alice",
      }),
    ).toBe(true);
  });

  it("refuses everyone when neither owner exists", () => {
    expect(
      canSteerSession({
        ownerUserId: null,
        callerUserId: "alice",
        fallbackOwnerUserId: null,
      }),
    ).toBe(false);
  });
});
