import { describe, expect, it } from "vitest";

import {
  CAPTURE_HEALTH_UNREPORTED,
  captureBehindReason,
  captureBytesWords,
  captureCaughtUp,
  captureDiscardAuditData,
  captureDiscardWords,
  captureDrainStep,
  CAPTURE_INCOMPLETE_REASONS,
  captureIncompleteWords,
  captureHarvestReady,
  captureProgressed,
  captureSaved,
  captureUnsavedWordsOf,
  captureSnapDetailOf,
  captureStatusLine,
  type CapturePosition,
  type CaptureReading,
  executorCapDue,
  captureOrderOf,
  executorEndOf,
  executorEndWords,
  observeCaptureThroughput,
  planExecutorCap,
  restatedSummary,
  executorSavedWords,
  executorUnansweredWords,
  CAPTURE_UNSAVED_ANSWERS_KEPT,
  withUnsavedAnswer,
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
  snapError: null,
  snapFailingSince: null,
  snapsFailed: null,
  unreadable: null,
  unreadablePaths: [],
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

  it("never reads saved, caught up or clean while a capture step is past its bound (e2e8)", () => {
    const overdue = {
      step: "small snap › git cat-file --batch-check",
      startedAt: new Date("2026-09-28T06:54:14Z"),
      runningMs: 17 * 60_000,
      boundMs: 120_000,
    };
    expect(captureSaved(reading({ overdue }))).toBe(false);
    expect(captureCaughtUp(reading({ unreadable: 0, complete: null, overdue }))).toBe(false);
    expect(captureBehindReason(reading({ unreadable: 0, complete: null, overdue }))).toBe(
      "capture step overdue",
    );
    expect(captureUnsavedWordsOf(reading({ overdue }))).toBe(
      "capture step overdue · small snap › git cat-file --batch-check · running 17 min · bound 2 min",
    );
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

describe("captureCaughtUp (the landing barrier, review 2026-09-28 #14)", () => {
  /** An answer from a daemon that reports snapshot health (`unreadable`, 0 when every path read). */
  const healthy = (patch: Partial<CaptureReading> = {}) => reading({ unreadable: 0, ...patch });

  it("is not caught up when the answer does not report snapshot health at all (review 3 #16, decision 9)", () => {
    // What `@sealant/sdk` 0.37.2's facade hands back: the queue, and nothing of the snapshots.
    expect(captureCaughtUp(reading({ complete: null }))).toBe(false);
    expect(captureBehindReason(reading({ complete: null }))).toBe(CAPTURE_HEALTH_UNREPORTED);
    expect(captureCaughtUp(healthy({ complete: null }))).toBe(true);
    expect(captureBehindReason(healthy({ complete: null }))).toBeNull();
  });

  it("is not caught up while the small class's last snap failed, a path could not be read, or the small class was refused, however empty the queue", () => {
    expect(captureCaughtUp(healthy({ complete: null }))).toBe(true);
    // A suspend snap that carried an unreadable file forward: empty queue, stale content.
    expect(
      captureCaughtUp(healthy({ complete: null, unreadable: 1, unreadablePaths: ["tree/app.ts"] })),
    ).toBe(false);
    expect(
      captureCaughtUp(
        healthy({
          complete: false,
          incompleteReason: "unreadable",
          snapError: "unreadable current source file",
          snapFailingSince: new Date(),
        }),
      ),
    ).toBe(false);
    expect(captureCaughtUp(healthy({ refused: 1, refusedClasses: ["small"] }))).toBe(false);
    expect(captureCaughtUp(healthy({ repairing: true }))).toBe(false);
    expect(captureCaughtUp(healthy({ paused: true }))).toBe(false);
    expect(captureCaughtUp(healthy({ pending: 1 }))).toBe(false);
  });

  it("a failing bulk snap or a bulk refusal does not hold up what needs only the small class", () => {
    const bulkFailing = healthy({
      complete: false,
      incompleteReason: "snapshot-failed",
      snapError: "EACCES: node_modules/.cache",
      snapFailingSince: new Date(),
      snaps: [
        { class: "small", failing: false },
        { class: "bulk", failing: true },
      ],
    });
    expect(captureCaughtUp(bulkFailing)).toBe(true);
    expect(captureCaughtUp(healthy({ refused: 1, refusedClasses: ["bulk"] }))).toBe(true);
    // Without per-class snaps, any failing snap holds it.
    expect(captureCaughtUp({ ...bulkFailing, snaps: null })).toBe(false);
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
        evidenceSaved: true,
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
        evidenceSaved: true,
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
        evidenceSaved: true,
      }).kind,
    ).toBe("saving");
    expect(
      captureDrainStep({
        previous: still,
        reading: still,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds,
        evidenceSaved: true,
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
        evidenceSaved: true,
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
          evidenceSaved: true,
        }).kind,
      ).toBe("not-saved");
    }
  });
});

// Review 2026-09-28 (10) #7, cross-repo decision 31: a completed answer is what the executor
// said; saved is the executor's evidence read as a whole.
describe("captureDrainStep over a completed answer the executor's evidence does not read saved", () => {
  it("does not read saved: the drain goes on, and is kept once nothing moved for the window", () => {
    const completed = reading();
    expect(captureSaved(completed)).toBe(true);
    expect(
      captureDrainStep({
        previous: completed,
        reading: completed,
        progressAtMs: 0,
        nowMs: 1_000,
        stallSeconds: 600,
        evidenceSaved: false,
      }),
    ).toEqual({ kind: "saving", progressAtMs: 0 });
    expect(
      captureDrainStep({
        previous: completed,
        reading: completed,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds: 600,
        evidenceSaved: false,
      }).kind,
    ).toBe("not-saved");
  });
});

describe("captureDrainStep while a final flush runs", () => {
  it("reads a final flush still running (`in-progress`) as saving, not kept", () => {
    const step = captureDrainStep({
      previous: null,
      reading: reading({ complete: false, incompleteReason: "in-progress" }),
      progressAtMs: 0,
      nowMs: 1,
      stallSeconds: 600,
      evidenceSaved: true,
    });
    expect(step.kind).not.toBe("not-saved");
    expect(captureIncompleteWords("in-progress")).toBeNull();
  });
});

describe("captureDrainStep while the completed flush is being sealed", () => {
  it("reads sealantd's `sealing` as a known reason the drain keeps asking about, worded as what is missing", () => {
    expect(CAPTURE_INCOMPLETE_REASONS).toContain("sealing");
    const step = captureDrainStep({
      previous: null,
      reading: reading({ complete: false, incompleteReason: "sealing" }),
      progressAtMs: 0,
      nowMs: 1,
      stallSeconds: 600,
      evidenceSaved: true,
    });
    expect(step.kind).not.toBe("not-saved");
    // e2e8: the sealing capture registered and its seal recorded, withheld for 20 minutes on
    // Garage while the line said `not registered`.
    expect(captureIncompleteWords("sealing")).toBe("final seal not confirmed");
  });
});

describe("captureDrainStep when the disk changed after the final flush (decision 7)", () => {
  it("reads sealantd's `changed` as not saved yet, a reason the drain keeps asking about", () => {
    expect(CAPTURE_INCOMPLETE_REASONS).toContain("changed");
    const changed = reading({ complete: false, incompleteReason: "changed" });
    expect(captureSaved(changed)).toBe(false);
    const step = captureDrainStep({
      previous: null,
      reading: changed,
      progressAtMs: 0,
      nowMs: 1,
      stallSeconds: 600,
      evidenceSaved: true,
    });
    expect(step.kind).toBe("saving");
    expect(captureIncompleteWords("changed")).toBe("changed after the final flush");
  });
});

describe("captureDrainStep when a capture class is polled (sealantd `unwatched`)", () => {
  it("reads `unwatched` as not saved yet, a reason the drain keeps asking about", () => {
    expect(CAPTURE_INCOMPLETE_REASONS).toContain("unwatched");
    const unwatched = reading({ complete: false, incompleteReason: "unwatched" });
    expect(captureSaved(unwatched)).toBe(false);
    const step = captureDrainStep({
      previous: null,
      reading: unwatched,
      progressAtMs: 0,
      nowMs: 1,
      stallSeconds: 600,
      evidenceSaved: true,
    });
    expect(step.kind).toBe("saving");
    expect(captureIncompleteWords("unwatched")).toBe(
      "a capture class is polled, currency not observed",
    );
  });
});

describe("captureDrainStep when the store cannot keep full fidelity (sealantd `store-fidelity`)", () => {
  it("reads `store-fidelity` as not saved at once, with words: no wait makes the store read more", () => {
    expect(CAPTURE_INCOMPLETE_REASONS).toContain("store-fidelity");
    const lossy = reading({ complete: false, incompleteReason: "store-fidelity" });
    expect(captureSaved(lossy)).toBe(false);
    const step = captureDrainStep({
      previous: null,
      reading: lossy,
      progressAtMs: 0,
      nowMs: 1,
      stallSeconds: 600,
      evidenceSaved: true,
    });
    expect(step.kind).toBe("not-saved");
    expect(captureIncompleteWords("store-fidelity")).toBe(
      "the store does not read every manifest feature this executor writes",
    );
    expect(captureUnsavedWordsOf(lossy)).toBe("incomplete · store-fidelity");
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
        evidenceSaved: true,
      }).kind,
    ).toBe("not-saved");
  });

  it("keeps the workspace at once when the executor cannot run a final flush, or is fenced", () => {
    for (const stuck of [
      // An older daemon: incomplete, no reason.
      reading({ complete: false }),
      reading({ complete: false, incompleteReason: "not-final" }),
      reading({ complete: false, incompleteReason: "conflict" }),
      // A daemon that cannot vouch that every writer stopped (no subreaper).
      reading({ complete: false, incompleteReason: "sweep-unavailable" }),
    ]) {
      expect(
        captureDrainStep({
          previous: null,
          reading: stuck,
          progressAtMs: 0,
          nowMs: 1,
          stallSeconds: 600,
          evidenceSaved: true,
        }).kind,
      ).toBe("not-saved");
    }
  });

  it("keeps the workspace at once when the final snapshot failed or met unreadable paths (e2e run 3: 80 FINALs over 606.7 s)", () => {
    for (const failed of [
      reading({ complete: false, incompleteReason: "snapshot-failed" }),
      reading({ complete: false, incompleteReason: "unreadable", unreadable: 1 }),
      // Any other reason, from a daemon that says a snap is failing.
      reading({ complete: false, incompleteReason: "pending", snapError: "EIO: tree/a" }),
      reading({
        complete: false,
        incompleteReason: "deadline",
        snapFailingSince: new Date("2026-09-27T10:00:00Z"),
      }),
    ]) {
      // Something moved (the executor shipped what it had), and still nothing will complete.
      expect(
        captureDrainStep({
          previous: reading({ pending: 3, registered: 1, complete: false }),
          reading: { ...failed, registered: 2 },
          progressAtMs: 0,
          nowMs: 1,
          stallSeconds: 600,
          evidenceSaved: true,
        }).kind,
      ).toBe("not-saved");
    }
  });

  it("keeps saving while a reported final flush is incomplete, until the stall window", () => {
    const incomplete = reading({ complete: false, incompleteReason: "ship-failed" });
    expect(
      captureDrainStep({
        previous: incomplete,
        reading: incomplete,
        progressAtMs: 0,
        nowMs: 1000,
        stallSeconds: 600,
        evidenceSaved: true,
      }).kind,
    ).toBe("saving");
    expect(
      captureDrainStep({
        previous: incomplete,
        reading: incomplete,
        progressAtMs: 0,
        nowMs: 600_000,
        stallSeconds: 600,
        evidenceSaved: true,
      }).kind,
    ).toBe("not-saved");
  });
});

describe("captureSnapDetailOf", () => {
  it("names sealantd's error, then the first path it could not read", () => {
    expect(captureSnapDetailOf(reading())).toBeNull();
    expect(captureSnapDetailOf(reading({ snapError: "EIO reading tree/db.sqlite" }))).toBe(
      "EIO reading tree/db.sqlite",
    );
    expect(
      captureSnapDetailOf(
        reading({ unreadable: 3, unreadablePaths: ["tree/secrets.pem", "tree/b", "tree/c"] }),
      ),
    ).toBe("unreadable tree/secrets.pem +2 more");
    expect(
      captureSnapDetailOf(
        reading({ snapError: "permission denied", unreadable: 1, unreadablePaths: ["tree/k"] }),
      ),
    ).toBe("permission denied · unreadable tree/k");
    expect(captureSnapDetailOf(reading({ unreadable: 2 }))).toBe("2 unreadable");
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

  it("says when the platform keeps the executor for recovery, without claiming the workspace is Mend's to keep", () => {
    expect(
      captureStatusLine({
        ...facts,
        captureDrain: "stop",
        capturePending: 0,
        captureNotSavedAt: new Date("2026-09-28T10:00:00.000Z"),
        captureIncompleteReason: "retained",
        captureIncompleteDetail: "exited before its final flush completed",
      }),
    ).toBe(
      "not saved · executor kept for recovery · exited before its final flush completed · 0 pending",
    );
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

  it("names what sealantd said behind a failed snapshot", () => {
    expect(
      captureStatusLine({
        ...facts,
        capturePending: 0,
        captureDrain: "stop",
        captureNotSavedAt: new Date("2026-09-27T10:00:00Z"),
        captureIncompleteReason: "snapshot-failed",
        captureIncompleteDetail: "unreadable tree/secrets.pem",
      }),
    ).toBe(
      "not saved · snapshot failed · unreadable tree/secrets.pem · 0 pending · workspace kept",
    );
  });

  it("says when a running executor's capture started failing, and why", () => {
    expect(
      captureStatusLine({
        ...facts,
        captureFailingSince: "2026-09-27T16:29:51.000Z",
        captureFailingError: "EIO: tree/db.sqlite",
      }),
    ).toBe("capture failing since 16:29:51 UTC · EIO: tree/db.sqlite");
    // A drain says what it says; the failure is behind its reason.
    expect(
      captureStatusLine({
        ...facts,
        captureDrain: "stop",
        captureFailingSince: new Date("2026-09-27T16:29:51Z"),
      }),
    ).toBe("saving");
  });

  it("says a capture step is past its bound (e2e8), in a drain too", () => {
    const overdue = {
      captureOverdueStep: "small snap › git cat-file --batch-check",
      captureOverdueSince: "2026-09-28T06:54:14.000Z",
      captureOverdueRunningMs: 17 * 60_000 + 5_000,
      captureOverdueBoundMs: 120_000,
    };
    expect(captureStatusLine({ ...facts, ...overdue })).toBe(
      "capture step overdue · small snap › git cat-file --batch-check · running 17 min · bound 2 min",
    );
    expect(captureStatusLine({ ...facts, ...overdue, captureDrain: "stop" })).toBe(
      "saving · capture step overdue · small snap › git cat-file --batch-check · running 17 min · bound 2 min",
    );
    expect(
      captureStatusLine({
        ...facts,
        ...overdue,
        capturePending: 0,
        captureDrain: "stop",
        captureNotSavedAt: new Date("2026-09-28T07:11:03Z"),
        captureIncompleteReason: "in-progress",
      }),
    ).toBe(
      "not saved · capture step overdue · small snap › git cat-file --batch-check · running 17 min · bound 2 min · 0 pending · workspace kept",
    );
  });

  it("says who discarded unsaved work, and when", () => {
    expect(
      captureStatusLine({
        ...facts,
        captureDiscardedAt: new Date("2026-09-27T16:40:02Z"),
        captureDiscardedBy: "Ada Lovelace",
      }),
    ).toBe("unsaved work discarded by Ada Lovelace at 16:40:02 UTC");
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

const endAt = (time: string) => new Date(`2026-09-27T${time}.000Z`);
const endWords = (endFacts: Parameters<typeof executorEndOf>[0]) =>
  executorEndWords(executorEndOf(endFacts));

describe("executorEndOf / executorEndWords (an executor that ended without Mend asking)", () => {
  const started = new Date("2026-09-27T16:20:00.000Z");
  const at = endAt;
  const never = { pending: null, pendingBytes: null, observedAt: null };

  it("a final capture that registered last, taken by this executor, is not a save on its own: the last capture, completion unknown (review 2026-09-28 #13)", () => {
    // sealantd staged its small Final, its bulk snapshot failed, and the small capture still
    // shipped carrying the older bulk section: the head is final-kind, its bulk is not
    // `pending`, nothing read pending after it — and the new bulk bytes were never saved.
    const end = executorEndOf({
      head: { kind: "final", n: 21, registeredAt: at("16:29:51"), bulkPending: false },
      executorStartedAt: started,
      reading: { pending: 0, pendingBytes: 0, observedAt: at("16:29:52") },
      finalSaved: null,
    });
    expect(end.kind).toBe("unconfirmed");
    expect(executorEndWords(end)).toBe(
      "stopped outside Mend · last capture 21 at 16:29:51 UTC · not confirmed",
    );
  });

  it("the store's sealed record of this executor's completed final flush is the save", () => {
    const end = executorEndOf({
      head: { kind: "final", n: 21, registeredAt: at("16:29:51"), bulkPending: false },
      executorStartedAt: started,
      reading: never,
      finalSaved: null,
      sealed: { at: at("16:29:51"), n: 21 },
    });
    expect(end.kind).toBe("saved");
    expect(executorEndWords(end)).toBe("stopped outside Mend · saved at 16:29:51 UTC · capture 21");
  });

  it("a final head never reads saved: bulk pending, a previous executor's, or work Mend saw pending after it", () => {
    const words = endWords;
    expect(
      words({
        head: { kind: "final", registeredAt: at("16:29:51"), bulkPending: true },
        executorStartedAt: started,
        reading: never,
      }),
    ).toBe("stopped outside Mend · last capture at 16:29:51 UTC · not confirmed");
    expect(
      words({
        head: { kind: "final", registeredAt: at("16:10:00"), bulkPending: false },
        executorStartedAt: started,
        reading: never,
      }),
    ).toBe("executor lost · last capture at 16:10:00 UTC · changes after it were not saved");
    expect(
      words({
        head: { kind: "final", registeredAt: at("16:29:51"), bulkPending: false },
        executorStartedAt: started,
        reading: { pending: 2, pendingBytes: null, observedAt: at("16:30:05") },
      }),
    ).toBe(
      "stopped outside Mend · last capture at 16:29:51 UTC · not confirmed · 2 pending at 16:30:05 UTC",
    );
  });

  it("a kill -9 says when it last captured and that later changes were not saved, never a count it did not observe", () => {
    const words = (observed: Parameters<typeof executorEndOf>[0]["reading"]) =>
      endWords({
        head: { kind: "auto", registeredAt: at("16:32:06"), bulkPending: false },
        executorStartedAt: started,
        reading: observed,
      });
    // Never read: nothing about pending.
    expect(words(never)).toBe(
      "executor lost · last capture at 16:32:06 UTC · changes after it were not saved",
    );
    // Read before the last save: stale, left out.
    expect(words({ pending: 3, pendingBytes: null, observedAt: at("16:31:00") })).toBe(
      "executor lost · last capture at 16:32:06 UTC · changes after it were not saved",
    );
    // Read after it: what was pending then, and when.
    expect(words({ pending: 1, pendingBytes: 675_321_064, observedAt: at("16:32:09") })).toBe(
      "executor lost · last capture at 16:32:06 UTC · changes after it were not saved · 675 MB pending at 16:32:09 UTC",
    );
    expect(words({ pending: 3, pendingBytes: null, observedAt: at("16:32:09") })).toBe(
      "executor lost · last capture at 16:32:06 UTC · changes after it were not saved · 3 pending at 16:32:09 UTC",
    );
    // Nothing pending read: nothing claimed either way.
    expect(words({ pending: 0, pendingBytes: 0, observedAt: at("16:32:09") })).toBe(
      "executor lost · last capture at 16:32:06 UTC · changes after it were not saved",
    );
    // A reading a previous executor took says nothing of this one.
    expect(
      executorEndWords(
        executorEndOf({
          head: null,
          executorStartedAt: started,
          reading: { pending: 4, pendingBytes: null, observedAt: at("16:00:00") },
        }),
      ),
    ).toBe("executor lost · nothing saved");
  });
});

describe("executorEndOf after a completed final flush (e2e run 4, 2026-09-27)", () => {
  const started = new Date("2026-09-27T19:47:45.000Z");
  const at = endAt;

  it("the executor's own `complete: true` is the save, whatever suspend captures registered after it", () => {
    // A final flush ran inside the executor (capture 21, complete), then Mend's stop flushes
    // staged two suspend captures on top: the head is `suspend`, and nothing Mend read after the
    // save said anything was left.
    const end = executorEndOf({
      head: { kind: "suspend", registeredAt: at("19:49:26"), bulkPending: false },
      executorStartedAt: started,
      reading: { pending: 0, pendingBytes: 0, observedAt: at("19:49:25") },
      finalSaved: { at: at("19:48:49"), n: 21 },
    });
    expect(end.kind).toBe("saved");
    expect(executorEndWords(end)).toBe("stopped outside Mend · saved at 19:48:49 UTC · capture 21");
  });

  it("a later answer that saw work pending revokes the save: the last confirmed save, and what came after it (review 2026-09-28 (4) #9)", () => {
    // Final capture 8 completed at 00:00:11; at 00:00:20 the executor reported 4096 bytes
    // pending; then it disappeared. It was not saved when it ended.
    const end = executorEndOf({
      head: {
        kind: "final",
        n: 8,
        registeredAt: new Date("2026-09-28T00:00:10Z"),
        bulkPending: false,
      },
      executorStartedAt: new Date("2026-09-28T00:00:00Z"),
      finalSaved: { at: new Date("2026-09-28T00:00:11Z"), n: 8, position: position(50, 8) },
      reading: {
        pending: 1,
        pendingBytes: 4096,
        observedAt: new Date("2026-09-28T00:00:20Z"),
        position: position(60, 8),
      },
    });
    expect(end.kind).toBe("lost");
    expect(executorEndWords(end)).toBe(
      "executor lost · last saved capture 8 at 00:00:11 UTC · changes after that were not saved · 4.1 KB pending at 00:00:20 UTC",
    );
    // Review 2026-09-28 (7) #4: a reading nothing orders against the save cannot say the work
    // after it was lost — the save is named, its completion unknown.
    const unordered = executorEndOf({
      head: {
        kind: "final",
        n: 8,
        registeredAt: new Date("2026-09-28T00:00:10Z"),
        bulkPending: false,
      },
      executorStartedAt: new Date("2026-09-28T00:00:00Z"),
      finalSaved: { at: new Date("2026-09-28T00:00:11Z"), n: 8 },
      reading: { pending: 1, pendingBytes: 4096, observedAt: new Date("2026-09-28T00:00:20Z") },
    });
    expect(executorEndWords(unordered)).toBe(
      "stopped outside Mend · last saved capture 8 at 00:00:11 UTC · completion unknown · 4.1 KB pending at 00:00:20 UTC",
    );
  });

  it("an unsaved answer Mend persisted after the save revokes it, whatever the last reading says; a seal likewise", () => {
    // The status after the save said a path was unreadable; the queue read empty after that.
    const afterSave = {
      head: { kind: "final", n: 8, registeredAt: at("19:48:48"), bulkPending: false },
      executorStartedAt: started,
      reading: { pending: 0, pendingBytes: 0, observedAt: at("19:49:30") },
      unsaved: [{ at: at("19:49:20"), words: "unreadable tree/after-seal.txt" }],
    } as const;
    const madeAfter = {
      ...afterSave,
      unsaved: [{ ...afterSave.unsaved[0], position: position(60, 8) }],
    } as const;
    expect(
      endWords({ ...madeAfter, finalSaved: { at: at("19:48:49"), n: 8, position: sealAt(8) } }),
    ).toBe(
      "executor lost · last saved capture 8 at 19:48:49 UTC · changes after that were not saved · unreadable tree/after-seal.txt at 19:49:20 UTC",
    );
    expect(
      endWords({ ...madeAfter, sealed: { at: at("19:48:49"), n: 8, position: sealAt(8) } }),
    ).toBe(
      "executor lost · last saved capture 8 at 19:48:49 UTC · changes after that were not saved · unreadable tree/after-seal.txt at 19:49:20 UTC",
    );
    // Without positions nothing orders the answer against the save (cross-repo decision 17): the
    // save does not stand, and nothing says the work after it was lost — completion unknown
    // (review 2026-09-28 (7) #4).
    expect(endWords({ ...afterSave, finalSaved: { at: at("19:48:49"), n: 8 } })).toBe(
      "stopped outside Mend · last saved capture 8 at 19:48:49 UTC · completion unknown · unreadable tree/after-seal.txt at 19:49:20 UTC",
    );
    expect(endWords({ ...afterSave, sealed: { at: at("19:48:49"), n: 8 } })).toBe(
      "stopped outside Mend · last saved capture 8 at 19:48:49 UTC · completion unknown · unreadable tree/after-seal.txt at 19:49:20 UTC",
    );
    // A newer completed final flush stands over the older unsaved answer — newer as the
    // executor ordered them (cross-repo decision 17); without positions nothing orders them.
    expect(endWords({ ...afterSave, finalSaved: { at: at("19:49:25"), n: 9 } })).toBe(
      "stopped outside Mend · last saved capture 9 at 19:49:25 UTC · completion unknown · unreadable tree/after-seal.txt at 19:49:20 UTC",
    );
    expect(
      endWords({
        ...afterSave,
        unsaved: [{ ...afterSave.unsaved[0], position: position(40, 8) }],
        finalSaved: { at: at("19:49:25"), n: 9, position: position(50, 9) },
      }),
    ).toBe("stopped outside Mend · saved at 19:49:25 UTC · capture 9");
  });

  // Review 2026-09-28 (6) #6, cross-repo decision 17: the seal is stamped by the store's clock,
  // the answer by a session worker's; a clock running ahead made an older seal look newer than a
  // later observed failure, and the end read `saved`.
  it("#6 a seal whose clock runs ahead never stands over an unsaved answer the executor made after it", () => {
    const sealedEnd = {
      head: { kind: "final", n: 8, registeredAt: at("19:48:48"), bulkPending: false },
      executorStartedAt: started,
      reading: { pending: 0, pendingBytes: 0, observedAt: at("19:49:30") },
      // The store's clock ran sixty seconds ahead of the worker that took the answer.
      sealed: { at: at("19:50:20"), n: 8, position: sealAt(8) },
    } as const;
    // Made after the seal, in the same boot or a later boot of the same disk.
    for (const after of [
      position(60, 8),
      { ...position(3, 8), bootId: "boot-b", bootGeneration: 2 },
    ]) {
      expect(
        executorEndOf({
          ...sealedEnd,
          unsaved: [
            { at: at("19:49:20"), words: "unreadable tree/after-seal.txt", position: after },
          ],
        }).kind,
      ).toBe("lost");
    }
    // Nothing orders it against the seal (no stamp, no epoch, another launch, a boot whose
    // generation was not persisted): fails closed — never saved, and never lost on evidence
    // that cannot say so: completion unknown (review 2026-09-28 (7) #4).
    for (const unordered of [
      null,
      { ...position(10, 7), observation: null },
      { ...position(10, 7), epoch: null },
      { ...position(10, 7), launchId: "launch-other" },
      { ...position(10, 7), bootId: "boot-b", bootGeneration: 0 },
    ]) {
      expect(
        executorEndOf({
          ...sealedEnd,
          unsaved: [{ at: at("19:49:20"), words: "incomplete · changed", position: unordered }],
        }).kind,
      ).toBe("unconfirmed");
    }
    // An answer asked and not published may say anything (review 2026-09-28 (7) #3): the seal
    // is named, completion unknown.
    expect(executorEndOf({ ...sealedEnd, settled: false }).kind).toBe("unconfirmed");
    // Made before it, earlier in the same boot: the seal stands, whatever the wall clock says.
    for (const before of [position(10, 7), position(49, 8)]) {
      expect(
        executorEndOf({
          ...sealedEnd,
          unsaved: [{ at: at("19:51:00"), words: "3 pending", position: before }],
        }).kind,
      ).toBe("saved");
    }
  });

  it("without that word, a suspend head is still `executor lost`", () => {
    expect(
      endWords({
        head: { kind: "suspend", registeredAt: at("19:49:26"), bulkPending: false },
        executorStartedAt: started,
        reading: { pending: 0, pendingBytes: 0, observedAt: at("19:49:25") },
        finalSaved: null,
      }),
    ).toBe("executor lost · last capture at 19:49:26 UTC · changes after it were not saved");
  });

  it("a save observed from a previous executor says nothing of this one", () => {
    expect(
      executorEndOf({
        head: { kind: "suspend", registeredAt: at("19:49:26"), bulkPending: false },
        executorStartedAt: started,
        reading: { pending: null, pendingBytes: null, observedAt: null },
        finalSaved: { at: at("19:40:00"), n: 12 },
      }).kind,
    ).toBe("lost");
  });
});

describe("what a discard records (e2e run 4, 2026-09-27)", () => {
  const at = endAt;
  const failing = {
    requestedAt: at("19:57:10"),
    workspaceId: "ws-1",
    lastSaved: { n: 37, at: at("19:54:41") },
    finalCompleted: null,
    failingSince: at("19:55:02"),
    failingError: "EACCES: tree/secrets.pem",
    // sealantd's queue read empty: a failing snap stages nothing, so it counts nothing.
    queue: { pending: 0, pendingBytes: 0, observedAt: at("19:57:08") },
  } as const;

  it("edits made while snaps failed are unsaved since the failure, never `0 pending`", () => {
    expect(captureDiscardWords(failing)).toBe(
      "asked at 19:57:10 UTC · last capture 37 at 19:54:41 UTC · unsaved since 19:55:02 UTC (snaps failing · EACCES: tree/secrets.pem) · no final flush completed",
    );
    const data = captureDiscardAuditData(failing, at("19:57:14"));
    expect(data).toEqual({
      requestedAt: "2026-09-27T19:57:10.000Z",
      discardedAt: "2026-09-27T19:57:14.000Z",
      workspaceId: "ws-1",
      lastSavedN: 37,
      lastSavedAt: "2026-09-27T19:54:41.000Z",
      finalCompleted: false,
      finalCompletedN: null,
      finalCompletedAt: null,
      snapsFailingSince: "2026-09-27T19:55:02.000Z",
      lastError: "EACCES: tree/secrets.pem",
      pending: null,
      pendingBytes: null,
      queuePending: 0,
      queuePendingBytes: 0,
      queueObservedAt: "2026-09-27T19:57:08.000Z",
      words: captureDiscardWords(failing),
    });
  });

  it("a queue read after the last save, with snaps succeeding, is what was pending", () => {
    const discard = {
      ...failing,
      failingSince: null,
      failingError: null,
      queue: { pending: 3, pendingBytes: 12_400_000, observedAt: at("19:57:08") },
    };
    expect(captureDiscardWords(discard)).toBe(
      "asked at 19:57:10 UTC · last capture 37 at 19:54:41 UTC · 12 MB pending at 19:57:08 UTC · no final flush completed",
    );
    const data = captureDiscardAuditData(discard, at("19:57:14"));
    expect(data["pending"]).toBe(3);
    expect(data["pendingBytes"]).toBe(12_400_000);
  });

  it("a queue read before the last save, or never, says nothing pending; a completed final is named", () => {
    const discard = {
      ...failing,
      failingSince: null,
      failingError: null,
      lastSaved: null,
      finalCompleted: { n: 40, at: at("19:56:00") },
      queue: null,
    };
    expect(captureDiscardWords(discard)).toBe(
      "asked at 19:57:10 UTC · nothing saved · final flush completed at 19:56:00 UTC · capture 40",
    );
    expect(captureDiscardAuditData(discard, at("19:57:14"))["finalCompleted"]).toBe(true);
    expect(
      captureDiscardWords({
        ...failing,
        failingSince: null,
        failingError: null,
        queue: { pending: 3, pendingBytes: null, observedAt: at("19:50:00") },
      }),
    ).toBe("asked at 19:57:10 UTC · last capture 37 at 19:54:41 UTC · no final flush completed");
  });
});

describe("restatedSummary (e2e run 6 #7)", () => {
  const saved = executorSavedWords({ at: new Date("2026-09-28T04:48:33Z"), n: 12 });
  it("replaces Mend's older word on the executor with the latest observation", () => {
    expect(saved).toBe("saved at 04:48:33 UTC · capture 12");
    expect(
      restatedSummary(
        "executor not answering · last saved capture 30 at 01:06:00 UTC · completion unknown",
        saved,
      ),
    ).toBe(saved);
    expect(restatedSummary("executor lost · last saved 16:32:06 UTC", saved)).toBe(saved);
  });
  it("keeps a failed launch's own words, and replaces only the verdict after them", () => {
    const once = restatedSummary("launch failed: setup command failed (exit 1)", saved);
    expect(once).toBe(`launch failed: setup command failed (exit 1) · ${saved}`);
    expect(restatedSummary(once, "executor lost · last saved 16:32:06 UTC")).toBe(
      "launch failed: setup command failed (exit 1) · executor lost · last saved 16:32:06 UTC",
    );
  });
  it("leaves a harness's own end alone", () => {
    expect(restatedSummary("exited with code 1", saved)).toBeNull();
    expect(restatedSummary(null, saved)).toBeNull();
  });
});

/** A position of executor `launch-1`, epoch 3, boot `boot-a` (generation 1). */
const position = (observation: number, headN: number | null) => ({
  epoch: 3,
  launchId: "launch-1",
  bootId: "boot-a",
  bootGeneration: 1,
  observation,
  headN,
});
/** The seal of capture `n` by the same executor and boot, at observation 50. */
const sealAt = (n: number) => ({ ...position(50, n) });

describe("captureOrderOf (cross-repo decision 17, sealantd's rule)", () => {
  it("orders one boot by observation, two boots of one disk by generation, and nothing else", () => {
    expect(captureOrderOf(position(9, 3), position(4, 3))).toBe("after");
    expect(captureOrderOf(position(4, 3), position(9, 3))).toBe("before");
    expect(captureOrderOf(position(4, 3), position(4, 3))).toBe("same");
    // One number naming two heads: contradictory.
    expect(captureOrderOf(position(4, 3), position(4, 5))).toBe("incomparable");
    // A recovery boot of the same disk counts up.
    const recovery = { ...position(2, 3), bootId: "boot-b", bootGeneration: 2 };
    expect(captureOrderOf(recovery, position(90, 3))).toBe("after");
    expect(captureOrderOf(position(90, 3), recovery)).toBe("before");
    // A generation of 0, one generation under two boots, another epoch or launch, a field
    // absent: nothing orders them.
    expect(captureOrderOf({ ...recovery, bootGeneration: 0 }, position(4, 3))).toBe("incomparable");
    expect(captureOrderOf({ ...recovery, bootGeneration: 1 }, position(4, 3))).toBe("incomparable");
    expect(captureOrderOf({ ...position(9, 3), epoch: 4 }, position(4, 3))).toBe("incomparable");
    expect(captureOrderOf({ ...position(9, 3), launchId: "other" }, position(4, 3))).toBe(
      "incomparable",
    );
    expect(captureOrderOf({ ...position(9, 3), observation: null }, position(4, 3))).toBe(
      "incomparable",
    );
    expect(captureOrderOf({ ...position(9, 3), bootId: null }, position(4, 3))).toBe(
      "incomparable",
    );
    expect(captureOrderOf(null, position(4, 3))).toBe("incomparable");
  });
});

type CapturePositionLike = CapturePosition | null;
/** An unsaved answer's words at a position, as `withUnsavedAnswer` keeps it. */
const unsavedAnswer = (words: string, where: CapturePositionLike) => ({ words, position: where });

// Review 2026-09-28 (9) #4, cross-repo decision 25: an executor's evidence kept one unsaved
// answer, and any answer nothing ordered against it replaced it — a recovery boot's failure was
// erased by a delayed older answer, and the old seal stood again. Every answer no kept one was
// made after is kept; a save stands only over all of them.
describe("withUnsavedAnswer (cross-repo decision 25)", () => {
  const at = endAt;
  const started = new Date("2026-09-27T19:47:45.000Z");
  const recoveryFailure = unsavedAnswer("unreadable tree/recovery-work.txt", {
    ...position(1, 8),
    bootId: "boot-b",
    bootGeneration: 0,
  });

  it("keeps every answer nothing kept was made after, and only a later answer of the same order removes one", () => {
    // The reviewer's order: boot B's failure, then boot A's delayed answer made before its seal.
    const kept = withUnsavedAnswer(
      withUnsavedAnswer([], recoveryFailure),
      unsavedAnswer("1 pending", position(40, 7)),
    );
    expect(kept.map((one) => one.words)).toEqual([
      "unreadable tree/recovery-work.txt",
      "1 pending",
    ]);
    // An answer boot A made after its 40 replaces that one; B's stays.
    const later = withUnsavedAnswer(kept, unsavedAnswer("2 pending", position(45, 7)));
    expect(later.map((one) => one.words)).toEqual([
      "unreadable tree/recovery-work.txt",
      "2 pending",
    ]);
    // One made before a kept one adds nothing; the same answer again replaces its copy.
    expect(withUnsavedAnswer(later, unsavedAnswer("0 pending", position(41, 7)))).toBe(later);
    expect(
      withUnsavedAnswer(later, unsavedAnswer("2 pending again", position(45, 7))).map(
        (one) => one.words,
      ),
    ).toEqual(["unreadable tree/recovery-work.txt", "2 pending again"]);
    // A recovery boot of the same disk with a persisted generation is after both of boot A's —
    // but still ordered against nothing of boot B's generation 0.
    const recovered = withUnsavedAnswer(
      later,
      unsavedAnswer("changed", {
        ...position(2, 8),
        bootId: "boot-c",
        bootGeneration: 2,
      }),
    );
    expect(recovered.map((one) => one.words)).toEqual([
      "unreadable tree/recovery-work.txt",
      "changed",
    ]);
    // Answers nothing can be ordered against: one stands for all of them, the latest received.
    const unstamped = withUnsavedAnswer(
      withUnsavedAnswer(recovered, unsavedAnswer("unstamped 1", null)),
      unsavedAnswer("unstamped 2", { ...position(3, 8), observation: null }),
    );
    expect(unstamped.map((one) => one.words)).toEqual([
      "unreadable tree/recovery-work.txt",
      "changed",
      "unstamped 2",
    ]);
  });

  it("folds past its cap into one answer no save covers", () => {
    let kept: ReadonlyArray<{ readonly words: string; readonly position: CapturePositionLike }> =
      [];
    for (let boot = 0; boot <= CAPTURE_UNSAVED_ANSWERS_KEPT; boot += 1) {
      kept = withUnsavedAnswer(
        kept,
        unsavedAnswer(`boot ${boot}`, {
          ...position(1, 8),
          bootId: `boot-${boot}`,
          bootGeneration: 0,
        }),
      );
    }
    expect(kept).toHaveLength(1);
    expect(kept[0]?.position).toBeNull();
    expect(kept[0]?.words).toContain(`${CAPTURE_UNSAVED_ANSWERS_KEPT + 1} unsaved answers`);
  });

  it("an executor end reads saved only when a save covers every kept answer", () => {
    const sealedEnd = {
      head: { kind: "final", n: 8, registeredAt: at("19:48:48"), bulkPending: false },
      executorStartedAt: started,
      reading: { pending: 0, pendingBytes: 0, observedAt: at("19:49:30") },
      sealed: { at: at("19:48:49"), n: 8, position: sealAt(8) },
    } as const;
    const unsaved = withUnsavedAnswer(
      withUnsavedAnswer([], { at: at("19:49:10"), ...recoveryFailure }),
      { at: at("19:49:20"), ...unsavedAnswer("1 pending", position(40, 7)) },
    );
    // The seal covers boot A's answer, not boot B's: completion unknown, never saved.
    expect(executorEndOf({ ...sealedEnd, unsaved }).kind).toBe("unconfirmed");
    expect(executorEndOf({ ...sealedEnd, unsaved: unsaved.slice(1) }).kind).toBe("saved");
  });
});

// e2e8 (i), HK and WU: `executor not answering · last saved capture 10 …` named the chain head,
// a capture that registered and was never sealed. A registered capture is never called saved.
describe("executorUnansweredWords (e2e8 (i))", () => {
  it("names the last registered capture as not confirmed, never as saved", () => {
    const at = new Date("2026-09-28T07:33:53Z");
    const words = executorUnansweredWords({ n: 10, at });
    expect(words).toBe("executor not answering · last capture 10 at 07:33:53 UTC · not confirmed");
    expect(words).not.toContain("saved");
    expect(executorUnansweredWords(null)).toBe(
      "executor not answering · nothing saved · completion unknown",
    );
  });
});
