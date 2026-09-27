import { describe, expect, it } from "vitest";

import {
  captureBytesWords,
  captureDrainStep,
  captureHarvestReady,
  captureProgressed,
  captureSaved,
  captureStatusLine,
  type CaptureReading,
  executorCapDue,
  observeCaptureThroughput,
  planExecutorCap,
} from "../src/workbench/capture-drain.ts";

const reading = (patch: Partial<CaptureReading> = {}): CaptureReading => ({
  pending: 0,
  pendingBytes: null,
  pendingBulk: null,
  refused: null,
  headN: 4,
  registered: 4,
  uploadedBytes: 4000,
  fenced: false,
  paused: false,
  bulkDirty: null,
  complete: true,
  incompleteReason: null,
  ...patch,
});

const facts = {
  capturePending: null,
  capturePendingBytes: null,
  captureRefused: null,
  captureDrain: null,
  captureNotSavedAt: null,
} as const;

describe("captureSaved", () => {
  it("needs a completed final flush, nothing pending, nobody fenced and nothing refused", () => {
    expect(captureSaved(reading())).toBe(true);
    expect(captureSaved(reading({ pending: 1 }))).toBe(false);
    expect(captureSaved(reading({ fenced: true }))).toBe(false);
    expect(captureSaved(reading({ refused: 1 }))).toBe(false);
  });

  it("never reads an empty queue as saved without the executor's `complete`", () => {
    // The queue is empty, but nothing says the executor quiesced and snapshotted both classes.
    expect(captureSaved(reading({ complete: null }))).toBe(false);
    expect(captureSaved(reading({ complete: false }))).toBe(false);
  });
});

describe("captureHarvestReady", () => {
  it("holds a handoff on every pending capture until sealantd says which are bulk", () => {
    expect(captureHarvestReady(reading({ pending: 2 }))).toBe(false);
    expect(captureHarvestReady(reading({ pending: 2, pendingBulk: 2 }))).toBe(true);
    expect(captureHarvestReady(reading({ pending: 3, pendingBulk: 2 }))).toBe(false);
    expect(captureHarvestReady(reading({ fenced: true }))).toBe(false);
  });
});

describe("captureProgressed", () => {
  it("reads fewer pending, fewer bytes, a newer head or more shipped as movement", () => {
    const before = reading({ pending: 3, pendingBytes: 9000 });
    expect(captureProgressed(null, before)).toBe(false);
    expect(captureProgressed(before, reading({ pending: 2, pendingBytes: 9000 }))).toBe(true);
    expect(captureProgressed(before, reading({ pending: 3, pendingBytes: 8000 }))).toBe(true);
    expect(captureProgressed(before, reading({ pending: 3, pendingBytes: 9000, headN: 5 }))).toBe(
      true,
    );
    expect(
      captureProgressed(before, reading({ pending: 3, pendingBytes: 9000, uploadedBytes: 4100 })),
    ).toBe(true);
    expect(captureProgressed(before, reading({ pending: 3, pendingBytes: 9000 }))).toBe(false);
  });
});

describe("captureDrainStep", () => {
  const stallSeconds = 600;
  it("terminates only at saved", () => {
    expect(
      captureDrainStep({
        previous: reading({ pending: 1 }),
        reading: reading(),
        progressAtMs: 0,
        nowMs: 1000,
        stallSeconds,
      }),
    ).toEqual({ kind: "saved" });
  });

  it("keeps saving while anything moves, however long it takes", () => {
    expect(
      captureDrainStep({
        previous: reading({ pending: 5 }),
        reading: reading({ pending: 4 }),
        progressAtMs: 0,
        nowMs: 3_600_000,
        stallSeconds,
      }),
    ).toEqual({ kind: "saving", progressAtMs: 3_600_000 });
  });

  it("reads not saved once nothing moved for the stall window, and not before", () => {
    const still = reading({ pending: 2 });
    expect(
      captureDrainStep({
        previous: still,
        reading: still,
        progressAtMs: 0,
        nowMs: 599_000,
        stallSeconds,
      }).kind,
    ).toBe("saving");
    expect(
      captureDrainStep({
        previous: still,
        reading: still,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds,
      }).kind,
    ).toBe("not-saved");
    // An executor that did not answer is no movement.
    expect(
      captureDrainStep({
        previous: still,
        reading: null,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds,
      }).kind,
    ).toBe("not-saved");
  });

  it("reads not saved at once when nothing can move: fenced, or refused", () => {
    for (const stuck of [reading({ pending: 1, fenced: true }), reading({ refused: 1 })]) {
      expect(
        captureDrainStep({
          previous: null,
          reading: stuck,
          progressAtMs: 0,
          nowMs: 1,
          stallSeconds,
        }).kind,
      ).toBe("not-saved");
    }
  });
});

describe("captureDrainStep without a completed final flush", () => {
  it("keeps the workspace at once when the executor cannot report `complete`", () => {
    expect(
      captureDrainStep({
        previous: null,
        reading: reading({ complete: null }),
        progressAtMs: 0,
        nowMs: 1,
        stallSeconds: 600,
      }).kind,
    ).toBe("not-saved");
  });

  it("keeps the workspace at once when the executor cannot run a final flush, or is fenced", () => {
    for (const stuck of [
      // An older daemon: incomplete, no reason.
      reading({ complete: false }),
      reading({ complete: false, incompleteReason: "not-final" }),
      reading({ complete: false, incompleteReason: "conflict" }),
    ]) {
      expect(
        captureDrainStep({
          previous: null,
          reading: stuck,
          progressAtMs: 0,
          nowMs: 1,
          stallSeconds: 600,
        }).kind,
      ).toBe("not-saved");
    }
  });

  it("keeps saving while a reported final flush is incomplete, until the stall window", () => {
    const incomplete = reading({ complete: false, incompleteReason: "snapshot-failed" });
    expect(
      captureDrainStep({
        previous: incomplete,
        reading: incomplete,
        progressAtMs: 0,
        nowMs: 1000,
        stallSeconds: 600,
      }).kind,
    ).toBe("saving");
    expect(
      captureDrainStep({
        previous: incomplete,
        reading: incomplete,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds: 600,
      }).kind,
    ).toBe("not-saved");
  });
});

describe("observeCaptureThroughput", () => {
  it("reads bytes and captures per second from lifetime counters, smoothed", () => {
    const first = observeCaptureThroughput(null, { atMs: 0, uploadedBytes: 0, registered: 0 });
    expect(first.bytesPerSecond).toBeNull();
    const second = observeCaptureThroughput(first, {
      atMs: 10_000,
      uploadedBytes: 10_000_000,
      registered: 5,
    });
    expect(second.bytesPerSecond).toBe(1_000_000);
    expect(second.objectsPerSecond).toBe(0.5);
    const third = observeCaptureThroughput(second, {
      atMs: 20_000,
      uploadedBytes: 30_000_000,
      registered: 5,
    });
    // 2 MB/s over the new interval, weighted into 1 MB/s; nothing registered keeps the rate.
    expect(third.bytesPerSecond).toBeCloseTo(1_300_000);
    expect(third.objectsPerSecond).toBe(0.5);
  });

  it("starts over when the counters go backwards: a new executor", () => {
    const moving = observeCaptureThroughput(
      observeCaptureThroughput(null, { atMs: 0, uploadedBytes: 0, registered: 0 }),
      { atMs: 10_000, uploadedBytes: 1000, registered: 1 },
    );
    const replaced = observeCaptureThroughput(moving, {
      atMs: 20_000,
      uploadedBytes: 10,
      registered: 0,
    });
    expect(replaced.bytesPerSecond).toBeNull();
    expect(replaced.objectsPerSecond).toBeNull();
  });
});

describe("captureStatusLine", () => {
  it("says what a drain has left, in captures until sealantd reports bytes", () => {
    expect(captureStatusLine({ ...facts, captureDrain: "stop" })).toBe("saving");
    expect(captureStatusLine({ ...facts, capturePending: 3, captureDrain: "stop" })).toBe(
      "saving · 3 left",
    );
    expect(
      captureStatusLine({
        ...facts,
        capturePending: 3,
        capturePendingBytes: 12_400_000,
        captureDrain: "replacement",
      }),
    ).toBe("saving · 12 MB left");
  });

  it("says what was kept once a drain stopped moving", () => {
    expect(
      captureStatusLine({
        ...facts,
        capturePending: 3,
        captureDrain: "stop",
        captureNotSavedAt: new Date("2026-09-27T10:00:00Z"),
      }),
    ).toBe("not saved · 3 pending · workspace kept");
  });

  it("says why a final flush did not complete, in plain words", () => {
    const kept = {
      ...facts,
      capturePending: 3,
      captureDrain: "stop" as const,
      captureNotSavedAt: new Date("2026-09-27T10:00:00Z"),
    };
    expect(captureStatusLine({ ...kept, captureIncompleteReason: "snapshot-failed" })).toBe(
      "not saved · snapshot failed · 3 pending · workspace kept",
    );
    expect(
      captureStatusLine({ ...kept, capturePending: 0, captureIncompleteReason: "unreported" }),
    ).toBe("not saved · final flush not reported · 0 pending · workspace kept");
  });

  it("names refusals outside a drain, and says nothing otherwise", () => {
    expect(captureStatusLine({ ...facts, captureRefused: 2 })).toBe("not saved · 2 refused");
    expect(captureStatusLine({ ...facts, capturePending: 4 })).toBeNull();
    expect(captureStatusLine(facts)).toBeNull();
  });

  it("words bytes plainly", () => {
    expect(captureBytesWords(812)).toBe("812 B");
    expect(captureBytesWords(4_200_000)).toBe("4.2 MB");
    expect(captureBytesWords(31_000_000_000)).toBe("31 GB");
  });
});

describe("planExecutorCap", () => {
  const started = new Date("2026-09-27T10:00:00Z");
  const base = {
    executorStartedAt: started,
    platformDeadline: null,
    maxSeconds: null,
    drainEstimateSeconds: 300,
    marginSeconds: 300,
    fallbackAgeSeconds: 27_000,
  };

  it("counts a stated cap from the executor's own start, less the estimate and the margin", () => {
    const plan = planExecutorCap({ ...base, maxSeconds: 3600 });
    expect(plan).toEqual({
      kind: "planned",
      source: "config",
      deadline: new Date("2026-09-27T11:00:00Z"),
      drainAt: new Date("2026-09-27T10:50:00Z"),
    });
    expect(executorCapDue(plan, new Date("2026-09-27T10:49:59Z").getTime())).toBe(false);
    expect(executorCapDue(plan, new Date("2026-09-27T10:50:00Z").getTime())).toBe(true);
  });

  it("prefers the platform's own deadline once it reports one", () => {
    const deadline = new Date("2026-09-27T10:30:00Z");
    const plan = planExecutorCap({ ...base, maxSeconds: 3600, platformDeadline: deadline });
    expect(plan.kind === "planned" && plan.source).toBe("platform");
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T10:20:00Z"));
  });

  it("gives a large pending upload the time its bytes need", () => {
    const plan = planExecutorCap({
      ...base,
      maxSeconds: 3600,
      pendingBytes: 1_200_000_000,
      bytesPerSecond: 1_000_000,
    });
    // 1200 s to upload + 300 s margin before 11:00.
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T10:35:00Z"));
  });

  it("gives many pending captures the time their registration rate needs", () => {
    const plan = planExecutorCap({
      ...base,
      maxSeconds: 3600,
      pendingObjects: 600,
      objectsPerSecond: 0.5,
    });
    // 1200 s at half a capture a second + 300 s margin before 11:00.
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T10:35:00Z"));
  });

  it("moves the fallback replacement earlier by what the pending bytes need beyond the estimate", () => {
    const plan = planExecutorCap({
      ...base,
      pendingBytes: 1_200_000_000,
      bytesPerSecond: 1_000_000,
    });
    // 1200 s needed, 300 s already in the estimate: 900 s before 17:30.
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T17:15:00Z"));
  });

  it("falls back to the replacement age when nothing states the cap, and knows nothing unlaunched", () => {
    const plan = planExecutorCap(base);
    expect(plan.kind === "planned" && plan.source).toBe("fallback");
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T17:30:00Z"));
    expect(planExecutorCap({ ...base, executorStartedAt: null })).toEqual({ kind: "unknown" });
    expect(executorCapDue({ kind: "unknown" }, Date.now())).toBe(false);
  });
});
