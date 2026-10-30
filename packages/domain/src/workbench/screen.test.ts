import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ScreenId, ViewerConnectionId } from "../ids.ts";
import {
  screenActionNote,
  DisplayNumber,
  SCREEN_LIMITS,
  ScreenActParams,
  type ScreenInput,
  type ScreenLife,
  screenIdleStopDue,
  ScreenSpan,
  screenStatusLine,
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

describe("screenStatusLine", () => {
  const now = new Date("2026-10-30T10:00:10Z");
  const live: ScreenLife = { _tag: "Live", degraded: null, browserSandboxOff: false };
  const line = (input: ScreenInput, facts: { life?: ScreenLife; viewers?: number } = {}) =>
    screenStatusLine({
      life: facts.life ?? live,
      input,
      lastFrameAt: new Date("2026-10-30T10:00:07Z"),
      viewers: facts.viewers ?? 0,
      now,
      nameOf: (userId) => (userId === "u-yiannis" ? "Yiannis" : userId),
    });
  const connection = ViewerConnectionId.make("connection");

  it.each<[ScreenInput, string]>([
    [{ _tag: "Agent", epoch: 1 }, "screen · agent has input · frame 3 s ago"],
    [
      { _tag: "Fencing", epoch: 2, by: "u-yiannis", to: { _tag: "Person", connection } },
      "screen · Yiannis taking over · frame 3 s ago",
    ],
    [
      { _tag: "Fencing", epoch: 3, by: "u-yiannis", to: { _tag: "AwaitingAgent" } },
      "screen · handing back to the agent · frame 3 s ago",
    ],
    [
      { _tag: "Person", epoch: 2, userId: "u-yiannis", connection },
      "screen · Yiannis has input · frame 3 s ago",
    ],
    [
      { _tag: "Paused", epoch: 3, reason: "disconnected", since: now },
      "screen · input paused · connection lost · frame 3 s ago",
    ],
    [
      { _tag: "Paused", epoch: 3, reason: "restart", since: now },
      "screen · input paused · Mend restarted · frame 3 s ago",
    ],
    [
      { _tag: "AwaitingAgent", epoch: 0 },
      "screen · waiting for the agent's next look · frame 3 s ago",
    ],
  ])("reads %j as observed", (input, expected) => {
    expect(line(input)).toBe(expected);
  });

  it("names a degraded screen, a browser without its sandbox, its watchers and a missing frame", () => {
    expect(
      line(
        { _tag: "Agent", epoch: 1 },
        {
          life: { _tag: "Live", degraded: "client-failed", browserSandboxOff: true },
          viewers: 2,
        },
      ),
    ).toBe(
      "screen · agent has input · frame 3 s ago · degraded · an app failed to start · browser sandbox off · 2 watching",
    );
    expect(
      screenStatusLine({
        life: live,
        input: { _tag: "AwaitingAgent", epoch: 0 },
        lastFrameAt: null,
        viewers: 0,
        now,
        nameOf: String,
      }),
    ).toBe("screen · waiting for the agent's next look · no frame yet");
  });

  it("reads a screen not started, starting or ended without its input", () => {
    const agent: ScreenInput = { _tag: "Agent", epoch: 1 };
    expect(line(agent, { life: { _tag: "NotStarted" } })).toBe("screen · not started");
    expect(line(agent, { life: { _tag: "Starting" } })).toBe("screen · starting");
    expect(line(agent, { life: { _tag: "Ended", reason: "idle" } })).toBe(
      "screen · ended after 15 min idle",
    );
    expect(line(agent, { life: { _tag: "Ended", reason: "session-stopped" } })).toBe(
      "screen · ended · session stopped",
    );
  });
});

describe("screenIdleStopDue", () => {
  const started = new Date("2026-10-30T10:00:00Z");
  const after = (ms: number) => started.getTime() + ms;
  const live: ScreenLife = { _tag: "Live", degraded: null, browserSandboxOff: false };
  const awaiting: ScreenInput = { _tag: "AwaitingAgent", epoch: 0 };
  const person: ScreenInput = {
    _tag: "Person",
    epoch: 1,
    userId: "yiannis",
    connection: ViewerConnectionId.make("connection-1"),
  };

  it("stops a started screen 15 minutes after its last activity", () => {
    const screen = { life: live, input: awaiting };
    expect(screenIdleStopDue(screen, started, after(SCREEN_LIMITS.idleStopMs - 1))).toBe(false);
    expect(screenIdleStopDue(screen, started, after(SCREEN_LIMITS.idleStopMs))).toBe(true);
    expect(
      screenIdleStopDue(
        { life: { _tag: "Starting" }, input: awaiting },
        started,
        after(SCREEN_LIMITS.idleStopMs),
      ),
    ).toBe(true);
  });

  it("keeps a screen a person holds, and has nothing to stop on one that is not running", () => {
    const late = after(10 * SCREEN_LIMITS.idleStopMs);
    expect(screenIdleStopDue({ life: live, input: person }, started, late)).toBe(false);
    expect(
      screenIdleStopDue({ life: { _tag: "NotStarted" }, input: awaiting }, started, late),
    ).toBe(false);
    expect(
      screenIdleStopDue(
        { life: { _tag: "Ended", reason: "idle" }, input: awaiting },
        started,
        late,
      ),
    ).toBe(false);
  });
});
