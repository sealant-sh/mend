import { describe, expect, it } from "vitest";

import {
  expiresCell,
  expiryDays,
  expiryLine,
  groupCode,
  lastUsed,
  pairingPayload,
  platformLabel,
  removalLine,
  shortDay,
  shownKeyLine,
} from "./devices.ts";

const now = new Date("2026-11-18T12:00:00.000Z");

describe("pairing", () => {
  it("reads a code in two halves and encodes the phone's link", () => {
    expect(groupCode("K7Q29MXA")).toBe("K7Q2-9MXA");
    expect(groupCode("SHORT")).toBe("SHORT");
    expect(pairingPayload("https://mend.example", "K7Q29MXA")).toBe(
      "mend://pair?u=https%3A%2F%2Fmend.example&c=K7Q29MXA",
    );
  });
});

describe("the device list", () => {
  it("names each platform", () => {
    expect(platformLabel("ios")).toBe("Mend app");
    expect(platformLabel("cli")).toBe("mend CLI");
    expect(platformLabel("other")).toBe("Token made by hand");
    expect(platformLabel("t3code")).toBe("t3code");
  });

  it("says when something was last used", () => {
    expect(lastUsed(null, now, "Not used yet")).toBe("Not used yet");
    expect(lastUsed("2026-11-18T11:59:30.000Z", now, "x")).toBe("Now");
    expect(lastUsed("2026-11-18T11:55:00.000Z", now, "x")).toBe("5 minutes ago");
    expect(lastUsed("2026-11-18T11:00:00.000Z", now, "x")).toBe("1 hour ago");
    expect(lastUsed("2026-11-15T12:00:00.000Z", now, "x")).toBe("3 days ago");
  });

  it("writes a day without the year when it is this year", () => {
    expect(shortDay("2026-11-09T10:00:00.000Z", now)).toBe("9 Nov");
    expect(shortDay("2025-03-02T10:00:00.000Z", now)).toBe("2 Mar 2025");
  });
});

describe("access keys", () => {
  it("asks the server for days, or none", () => {
    expect(expiryDays("90")).toBe(90);
    expect(expiryDays("never")).toBeNull();
    expect(expiryLine("90", now)).toBe("This key expires on 16 February 2027.");
    expect(expiryLine("never", now)).toContain("never expires");
  });

  it("shows when a key expires, and when it has", () => {
    expect(expiresCell(null, now)).toBe("Never");
    expect(expiresCell("2026-11-01T00:00:00.000Z", now)).toBe("Expired");
    expect(expiresCell("2026-12-01T00:00:00.000Z", now)).toBe("1 Dec");
    expect(shownKeyLine("2026-12-01T00:00:00.000Z", now)).toBe(
      "It expires on 1 December. You can revoke it on this page at any time.",
    );
  });
});

describe("workspace SSH keys", () => {
  it("says what a removal did to open connections", () => {
    expect(
      removalLine({ name: "build-box", openConnections: "end", runningSessions: [] }),
    ).toContain("end within a minute");
    expect(
      removalLine({ name: "build-box", openConnections: "stay", runningSessions: [] }),
    ).toContain("none of yours is running");
  });
});
