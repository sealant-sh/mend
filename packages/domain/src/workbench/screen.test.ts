import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ScreenId } from "../ids.ts";
import {
  screenActionNote,
  DisplayNumber,
  SCREEN_LIMITS,
  ScreenActParams,
  ScreenSpan,
} from "./screen.ts";

const accepts = Schema.is(ScreenActParams);
const batch = (...actions: ReadonlyArray<unknown>) => ({ actions });
const click = (x: number, y: number) => ({ kind: "click" as const, at: { x, y } });

describe("ScreenActParams", () => {
  it("accepts every action kind inside the 1280x800 screen", () => {
    expect(
      accepts(
        batch(
          { kind: "click", at: { x: 0, y: 0 }, button: "right", count: 2 },
          { kind: "move", to: { x: 1279, y: 799 } },
          { kind: "drag", from: { x: 10, y: 10 }, to: { x: 400, y: 300 } },
          { kind: "scroll", at: { x: 640, y: 400 }, dx: 0, dy: -SCREEN_LIMITS.scrollSteps },
          { kind: "type", text: "x".repeat(SCREEN_LIMITS.typeChars) },
          { kind: "key", combo: "ctrl+l" },
          { kind: "wait", ms: SCREEN_LIMITS.waitMs },
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["x past the right edge", click(1280, 0)],
    ["y past the bottom edge", click(0, 800)],
    ["a negative x", click(-1, 0)],
    ["a fractional y", click(10, 10.5)],
    ["a drag that ends off screen", { kind: "drag", from: { x: 0, y: 0 }, to: { x: 0, y: 900 } }],
    ["a scroll past its steps", { kind: "scroll", at: { x: 1, y: 1 }, dx: 0, dy: 21 }],
    ["text over 2,000 characters", { kind: "type", text: "x".repeat(2001) }],
    ["empty text", { kind: "type", text: "" }],
    ["a wait over 5 s", { kind: "wait", ms: 5001 }],
    ["a key combo with an empty part", { kind: "key", combo: "ctrl++" }],
    ["an unknown kind", { kind: "shell", command: "rm" }],
  ])("refuses %s", (_, action) => {
    expect(accepts(batch(action))).toBe(false);
  });

  it("refuses an empty batch and a batch over 20 actions", () => {
    const actions = Array.from({ length: SCREEN_LIMITS.batchActions }, () => click(5, 5));
    expect(accepts(batch(...actions))).toBe(true);
    expect(accepts(batch(...actions, click(5, 5)))).toBe(false);
    expect(accepts(batch())).toBe(false);
  });
});

describe("screen data shapes", () => {
  it("keeps display numbers between 10 and 99", () => {
    const valid = Schema.is(DisplayNumber);
    expect([9, 10, 99, 100].map(valid)).toEqual([false, true, true, false]);
  });

  it("refuses a span that ends before it starts", () => {
    const screenId = ScreenId.make("screen");
    expect(Schema.is(ScreenSpan)({ screenId, fromSeq: 3, toSeq: 3 })).toBe(true);
    expect(Schema.is(ScreenSpan)({ screenId, fromSeq: 4, toSeq: 3 })).toBe(false);
  });

  it("logs a typed text by its length only", () => {
    expect(screenActionNote({ kind: "type", text: "hunter2" }, "done")).toEqual({
      action: { kind: "type", length: 7 },
      result: "done",
    });
    expect(screenActionNote(click(3, 4), "skipped: taken over")).toEqual({
      action: click(3, 4),
      result: "skipped: taken over",
    });
  });
});
