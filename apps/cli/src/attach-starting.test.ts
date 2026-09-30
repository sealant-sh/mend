import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLEAR_LINE, firstOutputGate, startingLabelOf, startingLine } from "./attach-starting.ts";

describe("startingLine", () => {
  it("draws over the current line and says who is starting, where, for how long, and the way out", () => {
    expect(
      startingLine("claude", { startedAt: 0, freshMachine: true }, 23_000, "Ctrl+] detaches"),
    ).toBe(`${CLEAR_LINE}  claude is starting on the new machine · 23s · Ctrl+] detaches`);
    expect(startingLine("codex", { startedAt: null, freshMachine: false }, 1_400, "")).toBe(
      `${CLEAR_LINE}  codex is starting · 1s`,
    );
  });

  it("names a command of the owner's own and a shell as such", () => {
    expect(startingLabelOf("run")).toBe("the command");
    expect(startingLabelOf("shell")).toBe("the shell");
    expect(startingLabelOf("claude")).toBe("claude");
  });
});

describe("firstOutputGate", () => {
  let clock = 0;
  let written: string[] = [];
  const gate = () =>
    firstOutputGate({
      label: "claude",
      write: (text) => written.push(text),
      now: () => clock,
      cancelHint: "Ctrl+] detaches",
    });
  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    written = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing when output comes inside the grace: a reattach's replay never flashes the line", () => {
    const starting = gate();
    advance(100);
    starting.pass();
    advance(5_000);
    expect(written).toEqual([]);
  });

  it("is shown before the first output, ticks each second, and is erased the moment output comes", () => {
    const starting = gate();
    advance(400);
    expect(starting.shown()).toBe(true);
    expect(written).toEqual([
      startingLine("claude", { startedAt: null, freshMachine: false }, 400, "Ctrl+] detaches"),
    ]);
    advance(1_000);
    expect(written.at(-1)).toContain("claude is starting · 1s");
    // The session's detail answers: counted from the agent's own start, on its new machine.
    starting.update({ startedAt: clock - 23_000, freshMachine: true });
    expect(written.at(-1)).toContain("claude is starting on the new machine · 23s");

    starting.pass();
    expect(written.at(-1)).toBe(CLEAR_LINE);
    expect(starting.shown()).toBe(false);
    const count = written.length;
    advance(5_000);
    starting.pass();
    starting.stop();
    // Nothing more is drawn or erased over the agent's screen.
    expect(written).toHaveLength(count);
  });

  it("an attach that ends before any output erases the line it drew", () => {
    const starting = gate();
    advance(2_000);
    starting.stop();
    expect(written.at(-1)).toBe(CLEAR_LINE);
    advance(5_000);
    expect(written.at(-1)).toBe(CLEAR_LINE);
  });
});
