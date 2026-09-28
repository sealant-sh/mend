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
  it("needs nothing pending, nobody fenced and nothing refused", () => {
    expect(captureSaved(reading())).toBe(true);
    expect(captureSaved(reading({ pending: 1 }))).toBe(false);
    expect(captureSaved(reading({ fenced: true }))).toBe(false);
    expect(captureSaved(reading({ refused: 1 }))).toBe(false);
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

  it("falls back to the replacement age when nothing states the cap, and knows nothing unlaunched", () => {
    const plan = planExecutorCap(base);
    expect(plan.kind === "planned" && plan.source).toBe("fallback");
    expect(plan.kind === "planned" && plan.drainAt).toEqual(new Date("2026-09-27T17:30:00Z"));
    expect(planExecutorCap({ ...base, executorStartedAt: null })).toEqual({ kind: "unknown" });
    expect(executorCapDue({ kind: "unknown" }, Date.now())).toBe(false);
  });
});
