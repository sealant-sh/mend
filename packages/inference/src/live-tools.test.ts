import { ChangesRepo, RunsRepo } from "@mend/db";
import { Change, ChangeId, IssueId, Run, RunId, SealantRunId } from "@mend/domain";
import { runChangesOf, SealantClient } from "@mend/sealant";
import type { Run as SdkRun, RunChanges } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { readChangeLayer } from "./live-tools.ts";
import { ReadChange } from "./tools.ts";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const CHANGE = ChangeId.make("change-1");
const ISSUE = IssueId.make("issue-1");

/** Uncommitted work: no committed range, so read_change falls back to the run's changes. */
const change = new Change({
  id: CHANGE,
  issueId: ISSUE,
  branch: "mend/fix-login",
  baseSha: null,
  headSha: null,
  prNumber: null,
  prUrl: null,
  freshness: "current",
  movedBaseSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const run = new Run({
  id: RunId.make("run-1"),
  issueId: ISSUE,
  changeId: CHANGE,
  kind: "initial",
  sealantRunId: SealantRunId.make("sealant-run-1"),
  sealantWorkspaceId: null,
  status: "completed",
  outcome: "completed",
  summary: null,
  failureBrief: null,
  lastSeenSequence: 0n,
  startedAt: NOW,
  settledAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});

const notInTest = async (): Promise<never> => new Promise(() => undefined);

const sdkRun = (changes: RunChanges): SdkRun => ({
  id: "sealant-run-1",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes,
  artifacts: { list: async () => [], get: async () => new Uint8Array() },
  record: {
    runId: "sealant-run-1",
    replay: notInTest,
    commands: async () => [],
    transcript: async () => "",
    stream: async function* () {},
    timeline: async function* () {},
    scrollback: async function* () {},
    loss: notInTest,
    summary: notInTest,
    fileTreeAt: notInTest,
    processTreeAt: notInTest,
  },
  wait: async function () {
    return this;
  },
});

const readChange = (changes: RunChanges) =>
  Effect.gen(function* () {
    const tool = yield* ReadChange;
    return yield* tool.read(CHANGE);
  }).pipe(
    Effect.provide(
      readChangeLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ChangesRepo, { byId: () => Effect.succeed(change) }),
            Layer.mock(RunsRepo, { listForIssue: () => Effect.succeed([run]) }),
            Layer.mock(SealantClient, {
              getRun: () => Effect.succeed(sdkRun(changes)),
              runChanges: (read) => runChangesOf(read.changes),
            }),
          ),
        ),
      ),
    ),
  );

describe("read_change from a run's changes (sealant#313)", () => {
  it("says the changes were not read, and why, in place of an empty diff", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        readChange({
          files: [],
          diff: async () => "",
          available: false,
          unavailableReason: "no reading of the run's changes was recorded",
        }),
      ),
    );
    expect(error.tool).toBe("read_change");
    expect(error.message).toBe("changes not read · no reading of the run's changes was recorded");
  });

  it("says the changes were not read when Core gave no reason", async () => {
    const error = await Effect.runPromise(
      Effect.flip(readChange({ files: [], diff: async () => "", available: false })),
    );
    expect(error.message).toBe("changes not read · Core gave no reason");
  });

  it("shows a reading Core made, empty or not", async () => {
    const diff = "--- a/src/login.ts\n+++ b/src/login.ts\n+retry once\n";
    const view = await Effect.runPromise(
      readChange({
        files: [{ path: "src/login.ts", change: "modified" }],
        diff: async () => diff,
        available: true,
      }),
    );
    expect(view.diff).toBe(diff);
    expect(view.files.map((file) => ({ ...file }))).toEqual([
      { path: "src/login.ts", additions: 1, deletions: 0 },
    ]);

    const empty = await Effect.runPromise(
      readChange({ files: [], diff: async () => "", available: true }),
    );
    expect(empty.diff).toBe("");
    expect(empty.files).toEqual([]);
  });
});
