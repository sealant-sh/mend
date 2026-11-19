import { DEFAULT_NOTIFICATION_SETTINGS } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { isPhone, NOTIFICATION_SWITCHES, savedWords, withSwitch } from "./notifications.ts";

describe("phone notifications", () => {
  it("has one switch per setting the server keeps, in the frame's order", () => {
    expect(NOTIFICATION_SWITCHES.map((item) => item.key)).toEqual([
      "needsInput",
      "turnFinished",
      "failed",
      "slackSessions",
    ]);
    expect(new Set(NOTIFICATION_SWITCHES.map((item) => item.key))).toEqual(
      new Set(Object.keys(DEFAULT_NOTIFICATION_SETTINGS)),
    );
  });

  it("sends the whole setting with one switch changed", () => {
    const current = { needsInput: true, turnFinished: false, failed: true, slackSessions: false };
    expect(withSwitch(current, "turnFinished", true)).toEqual({ ...current, turnFinished: true });
  });

  it("says what a saved switch means, both ways", () => {
    expect(savedWords("turnFinished", true)).toBe(
      "You'll get a notification when a turn finishes.",
    );
    expect(savedWords("needsInput", false)).toBe(
      "You won't get a notification when a session is waiting on you.",
    );
  });

  it("counts only phones as places notifications go", () => {
    expect(["ios", "android", "web", "desktop", "other"].filter(isPhone)).toEqual([
      "ios",
      "android",
    ]);
  });
});
