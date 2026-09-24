import { describe, expect, it } from "vitest";

import type { SessionDto } from "./api.ts";
import { sessionFixture } from "./fixtures.ts";
import { describeWake, effectiveSnoozed, snoozePresets, wakeLabel } from "./snooze.ts";

const session = (status: SessionDto["status"], settledAt: string | null): SessionDto =>
  sessionFixture({
    id: "s",
    projectId: "p",
    worktree: "w",
    branch: "b",
    status,
    settledAt,
    createdAt: "2026-08-21T08:00:00.000Z",
  });

describe("snoozePresets", () => {
  it("offers the five presets at the exact hours on a weekday morning", () => {
    const now = new Date(2026, 7, 19, 10, 0); // Wednesday
    const presets = snoozePresets(now);
    expect(presets.map((p) => p.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets[2]?.until.getHours()).toBe(18);
    expect(presets[3]?.until.getDate()).toBe(20);
    expect(presets[3]?.until.getHours()).toBe(9);
    expect(presets[4]?.until.getDay()).toBe(1);
    expect(presets[4]?.until.getDate()).toBe(24);
  });

  it("drops This evening once it is within the hour, and after it", () => {
    expect(snoozePresets(new Date(2026, 7, 19, 17, 30)).map((p) => p.id)).not.toContain("evening");
    expect(snoozePresets(new Date(2026, 7, 19, 21, 0)).map((p) => p.id)).not.toContain("evening");
  });

  it("makes Next week a full week out on a Monday", () => {
    const monday = new Date(2026, 7, 17, 10, 0);
    const next = snoozePresets(monday).find((p) => p.id === "next-week");
    expect(next?.until.getDate()).toBe(24);
  });
});

describe("describeWake", () => {
  const now = new Date(2026, 7, 19, 10, 0);
  it("says just the time today, names tomorrow, the weekday within a week, and the date beyond", () => {
    expect(describeWake(new Date(2026, 7, 19, 18, 0), now)).toBe("18:00");
    expect(describeWake(new Date(2026, 7, 20, 9, 0), now)).toBe("tomorrow 09:00");
    expect(describeWake(new Date(2026, 7, 24, 9, 0), now)).toBe("Mon 09:00");
    expect(describeWake(new Date(2026, 8, 2, 9, 0), now)).toBe("Wed 2, 09:00");
  });
});

describe("wakeLabel", () => {
  const now = Date.parse("2026-08-19T10:00:00.000Z");
  it("rounds minutes up, never reads 0m, and says now once past", () => {
    expect(wakeLabel("2026-08-19T10:00:30.000Z", now)).toBe("1m");
    expect(wakeLabel("2026-08-19T12:00:00.000Z", now)).toBe("2h");
    expect(wakeLabel("2026-08-22T10:00:00.000Z", now)).toBe("3d");
    expect(wakeLabel("2026-08-19T09:59:00.000Z", now)).toBe("now");
  });
});

describe("effectiveSnoozed", () => {
  const at = "2026-08-19T10:00:00.000Z";
  const entry = { until: "2026-08-20T09:00:00.000Z", at };
  const now = Date.parse("2026-08-19T11:00:00.000Z");

  it("holds while the timer runs and the session minds its own business", () => {
    expect(effectiveSnoozed(session("running", null), entry, now)).toBe(true);
    expect(effectiveSnoozed(session("idle", null), entry, now)).toBe(true);
  });

  it("raises a hand for input, a fresh failure, or a settle after the snooze", () => {
    expect(effectiveSnoozed(session("waiting", null), entry, now)).toBe(false);
    expect(effectiveSnoozed(session("failed", "2026-08-19T10:30:00.000Z"), entry, now)).toBe(false);
    expect(effectiveSnoozed(session("completed", "2026-08-19T10:30:00.000Z"), entry, now)).toBe(
      false,
    );
  });

  it("keeps a session snoozed while already failed — that snooze meant 'seen, not now'", () => {
    expect(effectiveSnoozed(session("failed", "2026-08-19T09:00:00.000Z"), entry, now)).toBe(true);
  });

  it("ends at the wake time and never hides a row on malformed data", () => {
    expect(effectiveSnoozed(session("running", null), entry, Date.parse(entry.until))).toBe(false);
    expect(effectiveSnoozed(session("running", null), { until: "garbage", at }, now)).toBe(false);
  });
});
