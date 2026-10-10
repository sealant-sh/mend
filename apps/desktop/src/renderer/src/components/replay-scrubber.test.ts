import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkpointMarks, ReplayScrubber } from "#/components/replay-scrubber";
import type { CheckpointDto } from "#/lib/api";

const checkpoint = (ordinal: number, seq: string): CheckpointDto => ({
  id: `checkpoint-${ordinal}`,
  worktreeId: "worktree-1",
  sessionId: "session-1",
  ordinal,
  ref: `refs/mend/checkpoints/worktree-1/${ordinal}`,
  sha: `${ordinal}`.repeat(40),
  sealantRunId: "run-1",
  seq,
  trigger: ordinal === 0 ? "session-start" : "user-mark",
  createdAt: "2026-10-10T11:00:00.000Z",
});

/** The live pass's run: checkpoints 0 and 1 both at seq 0, checkpoint 2 at seq 75. */
const LIVE_PASS = [checkpoint(0, "0"), checkpoint(1, "0"), checkpoint(2, "75")];

describe("checkpointMarks", () => {
  it("gives checkpoints that share a seq their own place on the bar", () => {
    expect(
      checkpointMarks(LIVE_PASS).map(({ index, percent, offsetPx }) => ({
        index,
        percent,
        offsetPx,
      })),
    ).toEqual([
      { index: 0, percent: 0, offsetPx: 0 },
      { index: 1, percent: 0, offsetPx: 12 },
      { index: 2, percent: 100, offsetPx: 0 },
    ]);
  });

  it("grows inward at the far end, keeping checkpoint order left to right", () => {
    const marks = checkpointMarks([checkpoint(0, "0"), checkpoint(1, "40"), checkpoint(2, "40")]);
    expect(marks.map((mark) => [mark.percent, mark.offsetPx])).toEqual([
      [0, 0],
      [100, -12],
      [100, 0],
    ]);
  });

  it("leaves checkpoints at distinct seqs where their seq falls", () => {
    const marks = checkpointMarks([checkpoint(0, "0"), checkpoint(1, "25"), checkpoint(2, "100")]);
    expect(marks.map((mark) => [mark.percent, mark.offsetPx])).toEqual([
      [0, 0],
      [25, 0],
      [100, 0],
    ]);
  });
});

describe("ReplayScrubber", () => {
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
  });

  const label = () => host?.querySelector("p")?.textContent;
  const marker = (index: number): HTMLButtonElement => {
    const button = host?.querySelector<HTMLButtonElement>(
      `button[aria-label^="Replay from checkpoint ${index},"]`,
    );
    if (button === null || button === undefined) throw new Error(`no marker ${index}`);
    return button;
  };

  it("names the checkpoint that was clicked when another shares its seq", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSeek = vi.fn();
    act(() => {
      root.render(createElement(ReplayScrubber, { checkpoints: LIVE_PASS, from: "0", onSeek }));
    });

    expect(marker(0).style.left).toBe("0%");
    expect(marker(1).style.left).toBe("calc(0% + 12px)");
    expect(label()).toBe("▶ replay · from seq 0 · checkpoint 0 of 2");

    act(() => marker(1).click());
    expect(onSeek).toHaveBeenLastCalledWith("0");
    expect(label()).toBe("▶ replay · from seq 0 · checkpoint 1 of 2");
    expect(marker(1).getAttribute("aria-current")).toBe("true");
    expect(marker(0).getAttribute("aria-current")).toBeNull();

    act(() => marker(0).click());
    expect(label()).toBe("▶ replay · from seq 0 · checkpoint 0 of 2");
    act(() => root.unmount());
  });
});
