import { describe, expect, it } from "vitest";

import { commandLineState, type DeviceRow, signedInLine } from "./command-line.ts";

const device = (
  name: string,
  platform: string,
  createdAt: string,
  lastUsedAt: string | null = null,
): DeviceRow => ({ name, platform, createdAt, lastUsedAt });

describe("whether Mend's command line is signed in", () => {
  it("waits while the person has no computer signed in, phones and hand-made tokens included", () => {
    expect(commandLineState([])).toEqual({ kind: "waiting" });
    expect(
      commandLineState([
        device("Ada's iPhone", "ios", "2026-11-19T09:00:00Z"),
        device("ci", "other", "2026-11-19T09:00:00Z"),
      ]),
    ).toEqual({ kind: "waiting" });
  });

  it("names the computer used most recently, and counts the others", () => {
    const state = commandLineState([
      device("old-desktop", "cli", "2026-10-01T09:00:00Z", "2026-11-01T09:00:00Z"),
      device("linus-mbp", "cli", "2026-11-18T09:00:00Z", "2026-11-19T09:00:00Z"),
      device("Ada's iPhone", "ios", "2026-11-19T10:00:00Z", "2026-11-19T10:00:00Z"),
      // Signed in a minute ago and not used since: its sign-in is its last use.
      device("build-box", "cli", "2026-11-19T09:30:00Z"),
    ]);
    expect(state).toEqual({ kind: "signed-in", computer: "build-box", others: 2 });
    if (state.kind === "signed-in") {
      expect(signedInLine(state)).toBe("Mend's command line is signed in on build-box and 2 more.");
    }
  });

  it("says one computer without a count", () => {
    expect(signedInLine({ kind: "signed-in", computer: "linus-mbp", others: 0 })).toBe(
      "Mend's command line is signed in on linus-mbp.",
    );
  });
});
