import { describe, expect, it } from "vitest";

import {
  advanceFailure,
  advanceTarget,
  changeBody,
  emptySliceLine,
  movedLine,
  newerCheckpoint,
  observationLine,
  type CheckpointDto,
  type ObservationDto,
  type ReadFacts,
} from "./review-state";

const at = (iso: string) => iso.slice(11, 16);

const checkpoint = (ordinal: number, trigger = "turn-boundary"): CheckpointDto => ({
  id: `cp-${ordinal}`,
  ordinal,
  sha: `${ordinal}`.padStart(40, "0"),
  trigger,
  createdAt: `2026-09-27T10:${`${ordinal}`.padStart(2, "0")}:00.000Z`,
});

const ok: ReadFacts = { status: "success", error: null };
const pending: ReadFacts = { status: "pending", error: null };
const failed = (message: string): ReadFacts => ({ status: "error", error: new Error(message) });

describe("the body never dresses a failure as an empty change", () => {
  it("a refused open is a failure with the server's words, not 'nothing changed'", () => {
    const body = changeBody({
      open: failed("Signed out — sign in again."),
      diff: pending,
      slice: null,
    });
    expect(body).toEqual({
      kind: "failed",
      step: "open",
      line: "review · did not open",
      detail: "Signed out — sign in again.",
    });
  });

  it("a diff read that failed (StoreFailure) is a failure, retried at the diff", () => {
    const body = changeBody({
      open: ok,
      diff: failed("The Review patch did not match its persisted diff digest."),
      slice: null,
    });
    expect(body.kind).toBe("failed");
    expect(body.kind === "failed" && body.step).toBe("diff");
  });

  it("still reading is loading, and says which step", () => {
    expect(changeBody({ open: pending, diff: pending, slice: null })).toEqual({
      kind: "loading",
      line: "opening the review…",
    });
    expect(changeBody({ open: ok, diff: pending, slice: null })).toEqual({
      kind: "loading",
      line: "reading the slice…",
    });
  });

  it("an empty slice names its checkpoint and when it was taken", () => {
    const body = changeBody({
      open: ok,
      diff: ok,
      slice: { fileCount: 0, checkpointB: checkpoint(3) },
      format: at,
    });
    expect(body).toEqual({
      kind: "empty",
      line: "no files changed · checkpoint 3 · observed 10:03",
    });
    expect(emptySliceLine(checkpoint(3), at)).not.toMatch(/matches its base|nothing to review/);
  });

  it("a checkpoint taken from a Stop's final save says so, with that save's time, not its own", () => {
    const fromStop: CheckpointDto = {
      ...checkpoint(3),
      source: { kind: "stop-final", captureN: 12, observedAt: "2026-09-27T09:58:00.000Z" },
    };
    expect(emptySliceLine(fromStop, at)).toBe(
      "no files changed · checkpoint 3 · from the Stop's final save · capture 12 · 09:58",
    );
    expect(emptySliceLine(fromStop, at)).not.toContain("observed");
  });

  it("a slice with files renders the diff", () => {
    expect(
      changeBody({ open: ok, diff: ok, slice: { fileCount: 2, checkpointB: checkpoint(3) } }),
    ).toEqual({ kind: "files" });
  });

  it("a slice on screen stays while a newer open fails, and the failure is said beside it", () => {
    const facts = {
      open: failed("503"),
      diff: ok,
      slice: { fileCount: 2, checkpointB: checkpoint(3) },
    };
    expect(changeBody(facts)).toEqual({ kind: "files" });
    expect(advanceFailure(facts)).toEqual({
      step: "open",
      line: "a newer review did not open · 503",
    });
  });

  it("no failure line when nothing failed", () => {
    expect(
      advanceFailure({ open: ok, diff: ok, slice: { fileCount: 1, checkpointB: checkpoint(1) } }),
    ).toBeNull();
  });
});

describe("the pinned slice advances when the session takes a newer checkpoint", () => {
  const chain = [checkpoint(0, "session-start"), checkpoint(1), checkpoint(2, "review-open")];

  it("nothing newer than the pinned checkpoint: stay", () => {
    expect(newerCheckpoint(chain, checkpoint(2))).toBeNull();
    expect(
      advanceTarget({ chain, pinned: checkpoint(2), advancedFor: null, hold: false }),
    ).toBeNull();
  });

  it("a newer turn-boundary checkpoint: reopen for it", () => {
    const moved = [...chain, checkpoint(3)];
    expect(
      advanceTarget({ chain: moved, pinned: checkpoint(2), advancedFor: null, hold: false }),
    ).toBe("cp-3");
  });

  it("picks the newest when several landed", () => {
    const moved = [...chain, checkpoint(4, "command-settle"), checkpoint(3)];
    expect(newerCheckpoint(moved, checkpoint(2))?.id).toBe("cp-4");
  });

  it("a review-open checkpoint (another client's open, or its own) never triggers a reopen", () => {
    const opened = [...chain, checkpoint(3, "review-open")];
    expect(
      advanceTarget({ chain: opened, pinned: checkpoint(2), advancedFor: null, hold: false }),
    ).toBeNull();
  });

  it("reopens once per checkpoint: a reused slice (nothing moved) does not loop", () => {
    const moved = [...chain, checkpoint(3)];
    // The server reused the slice at checkpoint 2; checkpoint 3 already asked once.
    expect(
      advanceTarget({ chain: moved, pinned: checkpoint(2), advancedFor: "cp-3", hold: false }),
    ).toBeNull();
    // A later checkpoint asks again.
    expect(
      advanceTarget({
        chain: [...moved, checkpoint(5)],
        pinned: checkpoint(2),
        advancedFor: "cp-3",
        hold: false,
      }),
    ).toBe("cp-5");
  });

  it("holds while the reviewer writes, and advances once they stop", () => {
    const moved = [...chain, checkpoint(3)];
    expect(
      advanceTarget({ chain: moved, pinned: checkpoint(2), advancedFor: null, hold: true }),
    ).toBeNull();
    expect(
      advanceTarget({ chain: moved, pinned: checkpoint(2), advancedFor: null, hold: false }),
    ).toBe("cp-3");
  });

  it("no slice yet: nothing to advance from", () => {
    expect(advanceTarget({ chain, pinned: null, advancedFor: null, hold: false })).toBeNull();
  });
});

describe("observations name what they were judged against", () => {
  const capture: ObservationDto = {
    state: "observed",
    source: "capture",
    captureN: 7,
    captureId: "cap-7",
    seq: "412",
    partial: false,
    observedAt: "2026-09-27T10:18:00.000Z",
    label: "observed at capture 7",
  };

  it("capture mode: the moved-since line names the capture, not the worktree", () => {
    expect(
      movedLine(
        { worktreeChangedSinceSnapshot: true, checkpointB: checkpoint(3), observation: capture },
        at,
      ),
    ).toBe("capture 7 · observed 10:18 differs from checkpoint 3 · pull to refresh");
  });

  it("co-located: the worktree itself was compared", () => {
    expect(
      movedLine({
        worktreeChangedSinceSnapshot: true,
        checkpointB: checkpoint(3),
        observation: { ...capture, source: "worktree", captureN: null, observedAt: null },
      }),
    ).toBe("the worktree differs from checkpoint 3 · pull to refresh");
  });

  it("no line when the slice still matches", () => {
    expect(
      movedLine({
        worktreeChangedSinceSnapshot: false,
        checkpointB: checkpoint(3),
        observation: capture,
      }),
    ).toBeNull();
  });

  it("the stamp matches the web's (state · capture · time · partial)", () => {
    expect(observationLine(capture, at)).toBe("observed · capture 7 · 10:18");
    expect(observationLine({ ...capture, state: "claimed", partial: true }, at)).toBe(
      "claimed · capture 7 · 10:18 · partial",
    );
    expect(observationLine(undefined)).toBeNull();
  });
});
