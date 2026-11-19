import { describe, expect, it } from "vitest";

import { LANDING_SWITCH, REVIEW_SWITCHES, savedWords, withSwitch } from "./automation.ts";

const HELD = {
  autoTour: true,
  autoSuggest: false,
  autoName: true,
  autoLand: false,
  backgroundSessions: false,
};

describe("your automation", () => {
  it("sends every value with one switch changed", () => {
    expect(withSwitch(HELD, "autoLand", true)).toEqual({ ...HELD, autoLand: true });
    expect(withSwitch(HELD, "autoTour", false)).toEqual({ ...HELD, autoTour: false });
  });

  it("sends the values the page has no switch for back as the server holds them", () => {
    const flipped = { ...HELD, autoName: false, backgroundSessions: true };
    const sent = withSwitch(flipped, "autoSuggest", true);
    expect(sent.autoName).toBe(false);
    expect(sent.backgroundSessions).toBe(true);
  });

  it("shows the switches the frame draws, in its order", () => {
    expect([...REVIEW_SWITCHES, LANDING_SWITCH].map((item) => item.key)).toEqual([
      "autoTour",
      "autoSuggest",
      "autoLand",
    ]);
  });

  it("says what changed in either direction", () => {
    expect(savedWords("autoLand", true)).toBe("New sessions start with automatic landing on.");
    expect(savedWords("autoLand", false)).toBe("New sessions start with automatic landing off.");
    expect(savedWords("stopSessionOnSettle", false)).toBe(
      "Settling a thread in T3 Code leaves its session running.",
    );
  });
});
