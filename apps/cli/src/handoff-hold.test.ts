import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_WATCH_MS, type HeldSession, type HoldWatched, watchHold } from "./handoff.ts";

const session = (status: string, summary: string | null = null): HeldSession => ({
  id: "session-1",
  status,
  summary,
});

/** A watch over scripted reads on fake timers: each read answers the next entry, the last repeats. */
const watch = (reads: ReadonlyArray<HeldSession | Error | "hang">) => {
  const lines: Array<string> = [];
  let index = 0;
  let ended: HoldWatched | null = null;
  const outcome = watchHold({
    from: session("starting"),
    read: () => {
      const next = reads[Math.min(index, reads.length - 1)];
      index += 1;
      if (next === undefined) return Promise.reject(new Error("no scripted read"));
      if (next === "hang") return new Promise<HeldSession>(() => undefined);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    onLine: (line) => lines.push(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  }).then((watched) => {
    ended = watched;
    return watched;
  });
  return { outcome, lines, ended: () => ended, reads: () => index };
};

describe("watchHold", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads until the session is held, saying each new starting line once", async () => {
    const run = watch([
      session("starting"),
      session("starting", "preparing the workspace"),
      session("starting", "preparing the workspace"),
      session("idle"),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.ended()).toEqual({ _tag: "settled", session: session("idle") });
    expect(run.lines).toEqual(["starting · preparing the workspace"]);
  });

  it("ends on a failed hold with the server's words", async () => {
    const failed = session("failed", "hold failed: the workspace did not start");
    const run = watch([session("starting"), failed]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.ended()).toEqual({ _tag: "settled", session: failed });
  });

  it("reads again after a read that fails or never answers", async () => {
    const run = watch([new Error("fetch failed"), "hang", session("idle")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.ended()).toEqual({ _tag: "settled", session: session("idle") });
    expect(run.reads()).toBe(3);
  });

  it("stops at the time limit while the hold still reads starting, and not before", async () => {
    const run = watch([session("starting")]);
    await vi.advanceTimersByTimeAsync(HOLD_WATCH_MS - 1);
    expect(run.ended()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.ended()).toEqual({ _tag: "timedOut" });
  });

  it("stops at the time limit when a read hangs across it", async () => {
    const run = watch(["hang"]);
    await vi.advanceTimersByTimeAsync(HOLD_WATCH_MS);
    expect(run.ended()).toEqual({ _tag: "timedOut" });
  });
});
