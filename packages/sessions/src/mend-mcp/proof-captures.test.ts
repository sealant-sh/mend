import { createHash } from "node:crypto";

import {
  AgentConversationRepo,
  ProofArtifactsRepo,
  ProofArtifactStorageError,
  ScreensRepo,
  WorktreeChangesRepo,
} from "@mend/db";
import {
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenFrameId,
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  Change,
  Checkpoint,
  DisplayNumber,
  ProofArtifact,
  type ProofVideoEnding,
  ScreenLogEntry,
} from "@mend/domain/workbench";
import { BlobStore, BlobNotFoundError, BlobStoreError, GitError } from "@mend/store";
import { Deferred, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SessionEngine } from "../engine.ts";
import {
  type RecordedVideo,
  RecorderRefusal,
  RecordingId,
  RecordingUnavailable,
  ScreenRecorder,
} from "../screen/recorder.ts";
import { ScreenStartError } from "../screen/screen-host.ts";
import { Screens, type ScreenCallAnswer, type ScreenRefusal } from "../screen/screens.ts";
import type { Caller } from "./caller.ts";
import { ProofCaptures, ProofCapturesLive } from "./proof-captures.ts";

const SESSION = SessionId.make("proof-session");
const SCREEN = ScreenId.make("proof-screen");
const caller: Caller = {
  sessionId: SESSION,
  accountId: "alice",
  agentProcess: { _tag: "Current", id: SessionProcessId.make("proof-process") },
  callKey: "call",
};
const base = Sha.make("abcdef123");
const change = new Change({
  id: ChangeId.make("change"),
  worktreeId: WorktreeId.make("tree"),
  projectId: ProjectId.make("project"),
  sessionId: SESSION,
  baseSha: base,
  branch: "mend/tree",
  headSha: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const checkpoint = new Checkpoint({
  id: CheckpointId.make("checkpoint"),
  worktreeId: change.worktreeId,
  sessionId: SESSION,
  ordinal: 4,
  ref: "refs/mend/checkpoints/tree/4",
  sha: Sha.make("1234567"),
  sealantRunId: null,
  seq: 0n,
  trigger: "proof-capture",
  createdAt: new Date(),
});
const png = new Uint8Array([137, 80, 78, 71, 1, 2]);
const digest = createHash("sha256").update(png).digest("hex");
const params = {
  title: "Task board",
  caption: "A completed task",
} satisfies Parameters<ProofCaptures["Service"]["screenshot"]>[1];

const fixture = (
  options: {
    readonly refusal?: ScreenRefusal;
    readonly look?: Effect.Effect<ScreenCallAnswer, ScreenStartError>;
    readonly checkpointFailed?: boolean;
    readonly frameNotStored?: boolean;
    readonly recorderRefusal?: RecorderRefusal["reason"];
    readonly mediaUnavailable?: boolean;
    readonly blobFailed?: boolean;
    readonly insertFailed?: boolean;
    readonly waitForActs?: ReturnType<Screens["Service"]["waitForActs"]>;
  } = {},
) => {
  const artifacts = new Map<ProofArtifactId, ProofArtifact>();
  const calls = new Map<string, ProofArtifact>();
  const blobs = new Map<string, Uint8Array>([[`screen-frames/${SCREEN}/${digest}.png`, png]]);
  const copied: Array<string> = [];
  let looks = 0;
  let checkpoints = 0;
  let starts = 0;
  let stops = 0;
  let writes = 0;
  let inserts = 0;
  let seq = 7;
  const video = Deferred.makeUnsafe<RecordedVideo, RecordingUnavailable>();
  const settled = Deferred.makeUnsafe<void>();
  const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const finish = (ending: ProofVideoEnding) =>
    options.mediaUnavailable
      ? Deferred.fail(video, new RecordingUnavailable({ reason: "invalid_media" }))
      : Deferred.succeed(video, {
          mp4,
          durationMs: ending === "time-limit" ? 60_000 : 1_500,
          ending,
        });
  const layer = ProofCapturesLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ScreenRecorder, {
          start: (screen) =>
            Effect.suspend(() => {
              expect(checkpoints).toBeGreaterThan(0);
              expect(screen).toMatchObject({ screenId: SCREEN, sessionId: SESSION, display: 12 });
              starts += 1;
              return options.recorderRefusal !== undefined
                ? Effect.fail(new RecorderRefusal({ reason: options.recorderRefusal }))
                : Effect.succeed(RecordingId.make("recording"));
            }),
          stop: () =>
            Effect.gen(function* () {
              stops += 1;
              yield* finish("stopped");
              return yield* Deferred.await(video);
            }),
          onFinished: () => Deferred.await(video),
        }),
        Layer.mock(ScreensRepo, {
          log: () =>
            Effect.sync(() => [
              Schema.decodeUnknownSync(ScreenLogEntry)({
                screenId: SCREEN,
                seq,
                at: new Date(),
                actor: { _tag: "Mend" },
                body: { _tag: "Started", browserSandboxOff: false },
                frame: null,
                checkpoint: null,
              }),
            ]),
        }),
        Layer.mock(ProofArtifactsRepo, {
          byCall: (sessionId, key) =>
            Effect.sync(() => {
              const saved = calls.get(`${sessionId}:${key}`);
              return saved === undefined ? null : (artifacts.get(saved.id) ?? null);
            }),
          byId: (id) => Effect.sync(() => artifacts.get(id) ?? null),
          settleVideo: (id, capture) =>
            Effect.gen(function* () {
              const previous = artifacts.get(id);
              if (previous === undefined) return null;
              if (previous.capture._tag !== "Recording") return previous;
              const saved = new ProofArtifact({ ...previous, capture, observedTo: new Date() });
              artifacts.set(id, saved);
              yield* Deferred.succeed(settled, undefined);
              return saved;
            }),
          insert: (artifact, key) =>
            Effect.suspend(() => {
              inserts += 1;
              if (options.insertFailed && inserts === 1)
                return Effect.fail(
                  new ProofArtifactStorageError({ cause: "database unavailable" }),
                );
              return Effect.sync(() => {
                artifacts.set(artifact.id, artifact);
                calls.set(`${artifact.sessionId}:${key}`, artifact);
                return artifact;
              });
            }),
        }),
        Layer.mock(WorktreeChangesRepo, { bySession: () => Effect.succeed(change) }),
        Layer.mock(AgentConversationRepo, { listTurns: () => Effect.succeed([]) }),
        Layer.mock(SessionEngine, {
          launchUnderWay: () => false,
          checkpointNow: (_, trigger) =>
            Effect.suspend(() => {
              checkpoints += 1;
              expect(trigger).toBe("proof-capture");
              return options.checkpointFailed
                ? Effect.fail(
                    new GitError({ args: [], cwd: "/repo", exitCode: 1, stderr: "unavailable" }),
                  )
                : Effect.succeed(checkpoint);
            }),
        }),
        Layer.mock(Screens, {
          waitForActs: () => options.waitForActs ?? Effect.succeed("idle"),
          authorize: (who) =>
            Effect.succeed(
              options.refusal ??
                (who.agentProcess?._tag !== "Current" || who.callKey === null
                  ? "unattributed_caller"
                  : who.accountId !== "alice"
                    ? "owner_only"
                    : null),
            ),
          state: () =>
            Effect.succeed({
              screen: {
                id: SCREEN,
                sessionId: SESSION,
                workspaceId: SealantWorkspaceId.make("workspace"),
                display: DisplayNumber.make(12),
                processId: SessionProcessId.make("screen-process"),
                life: { _tag: "Live", degraded: null, browserSandboxOff: false },
                input: { _tag: "Agent", epoch: 0 },
              },
              takenAt: null,
            }),
          look: (who) =>
            Effect.suspend(() => {
              looks += 1;
              return (
                options.look ??
                Effect.succeed<ScreenCallAnswer>({
                  _tag: "Answered",
                  outcome: "applied",
                  receipt: { screenId: SCREEN, seq: 7, callKey: who.callKey ?? "" },
                  png,
                  observedAt: new Date("2026-11-01T14:02:00Z"),
                  frameId: options.frameNotStored
                    ? null
                    : ScreenFrameId.make(`${SCREEN}.${digest}`),
                  actions: [],
                  sinceLastLook: [],
                })
              );
            }),
        }),
        Layer.mock(BlobStore, {
          identity: "memory:proof",
          get: (key) =>
            Effect.suspend(() => {
              const bytes = blobs.get(key);
              return bytes === undefined
                ? Effect.fail(new BlobNotFoundError({ key }))
                : Effect.succeed(bytes);
            }),
          copy: (from, to) =>
            Effect.suspend(() => {
              const bytes = blobs.get(from);
              if (bytes === undefined) return Effect.fail(new BlobNotFoundError({ key: from }));
              blobs.set(to, bytes.slice());
              copied.push(to);
              return Effect.void;
            }),
          put: (key, body, optionsPut) =>
            Effect.suspend(() => {
              if (options.blobFailed)
                return Effect.fail(
                  new BlobStoreError({ operation: "put", key, cause: "unavailable" }),
                );
              writes += 1;
              expect(optionsPut).toEqual({ ifAbsent: true });
              if (!(body instanceof Uint8Array)) throw new Error("expected media");
              blobs.set(key, body.slice());
              return Effect.succeed({ written: true });
            }),
        }),
      ),
    ),
  );
  return {
    layer,
    artifacts,
    blobs,
    copied,
    mp4,
    finish,
    settled: Deferred.await(settled),
    setSeq: (next: number) => {
      seq = next;
    },
    starts: () => starts,
    stops: () => stops,
    writes: () => writes,
    looks: () => looks,
    checkpoints: () => checkpoints,
  };
};

const run = <A>(
  world: ReturnType<typeof fixture>,
  body: (captures: ProofCaptures["Service"]) => Effect.Effect<A>,
) => Effect.runPromise(Effect.flatMap(ProofCaptures, body).pipe(Effect.provide(world.layer)));

describe("proof captures on the session's screen", () => {
  it("takes no screenshot or checkpoint when earlier screen actions do not settle in time", async () => {
    const world = fixture({ waitForActs: Effect.succeed("timed_out") });
    const answer = await run(world, (captures) => captures.screenshot(caller, params));
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain("Waited 60 s");
    expect(world.artifacts.size).toBe(0);
    expect(world.looks()).toBe(0);
    expect(world.checkpoints()).toBe(0);
  });
  it("pins a checkpoint, keeps its own PNG, and retries without another look", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const first = yield* captures.screenshot(caller, params);
        const retry = yield* captures.screenshot(caller, { ...params, title: "Ignored retry" });
        expect(retry).toEqual(first);
        expect(first.structuredContent).toBeUndefined();
        expect(first.content[0]).toMatchObject({ type: "image", data: png, mimeType: "image/png" });
        expect(world.looks()).toBe(1);
        expect(world.checkpoints()).toBe(1);
        const stored = [...world.artifacts.values()][0];
        expect(stored?.source).toEqual({
          _tag: "Checkpoint",
          checkpointId: checkpoint.id,
          ordinal: 4,
          commit: checkpoint.sha,
        });
        expect(stored?.capture).toMatchObject({
          _tag: "Screenshot",
          moment: { screenId: SCREEN, seq: 7 },
        });
        if (stored?.capture._tag !== "Screenshot") throw new Error("missing screenshot");
        expect(world.copied).toEqual([stored.capture.media.blobKey]);
        world.blobs.delete(`screen-frames/${SCREEN}/${digest}.png`);
        expect(world.blobs.get(stored.capture.media.blobKey)).toEqual(png);
        expect(yield* captures.screenshot(caller, params)).toEqual(first);
        expect(stored.observedFrom.toISOString()).toBe("2026-11-01T14:02:00.000Z");
      }),
    );
  });
  it("pins a checkpoint, and concurrent retries keep one artifact", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const replies = yield* Effect.all(
          [captures.screenshot(caller, params), captures.screenshot(caller, params)],
          { concurrency: "unbounded" },
        );
        expect(replies[0]).toEqual(replies[1]);
        expect(world.artifacts.size).toBe(1);
        expect(world.looks()).toBe(1);
        expect(world.checkpoints()).toBe(1);
        expect([...world.artifacts.values()][0]?.source).toEqual({
          _tag: "Checkpoint",
          checkpointId: checkpoint.id,
          ordinal: 4,
          commit: checkpoint.sha,
        });
      }),
    );
  });
  it("still captures when checkpointing fails, labelled source unknown", async () => {
    const world = fixture({ checkpointFailed: true });
    const result = await run(world, (captures) => captures.screenshot(caller, params));
    expect(result.isError).not.toBe(true);
    expect([...world.artifacts.values()][0]?.source).toMatchObject({ _tag: "Unknown" });
    expect(JSON.stringify(result.content)).toContain("source unknown");
  });
  it.each([
    "held",
    "owner_only",
    "unattributed_caller",
    "no_screen",
    "busy",
  ] satisfies Array<ScreenRefusal>)("records nothing on %s refusal", async (refusal) => {
    const world = fixture({ refusal });
    const result = await run(world, (captures) => captures.screenshot(caller, params));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(refusal);
    expect(world.artifacts.size).toBe(0);
    expect(world.looks()).toBe(0);
  });
  it("records no artifact when Screens.look refuses or fails to start", async () => {
    for (const look of [
      Effect.succeed<ScreenCallAnswer>({ _tag: "Refused", refusal: "held" }),
      Effect.fail(new ScreenStartError({ message: "not started" })),
    ]) {
      const world = fixture({ look });
      expect((await run(world, (captures) => captures.screenshot(caller, params))).isError).toBe(
        true,
      );
      expect(world.artifacts.size).toBe(0);
    }
  });
  it("stores the returned PNG when the screen frame could not be retained", async () => {
    const world = fixture({ frameNotStored: true });
    expect((await run(world, (captures) => captures.screenshot(caller, params))).isError).not.toBe(
      true,
    );
    expect(world.artifacts.size).toBe(1);
    expect(world.copied).toHaveLength(0);
  });
  it("records missing capture with its reason and no look or blob", async () => {
    const world = fixture();
    const result = await run(world, (captures) =>
      captures.missing(caller, {
        title: "Board",
        kind: "screenshot",
        reason: "Missing test account",
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(world.looks()).toBe(0);
    expect(world.checkpoints()).toBe(1);
    expect([...world.artifacts.values()][0]?.capture).toEqual({
      _tag: "NotCaptured",
      kind: "screenshot",
      reason: "Missing test account",
    });
    expect(JSON.stringify(result)).toContain("not captured");
  });
});

const videoParams = {
  title: "Task board",
  caption: "A completed task",
  launch: "pnpm dev :3000",
  differences: "Seeded task",
};
const stopCaller = { ...caller, callKey: "stop" };

describe("proof videos on the session's screen", () => {
  it("keeps recording after a screen wait times out and lets the stop be retried", async () => {
    let waiting = true;
    const world = fixture({ waitForActs: Effect.sync(() => (waiting ? "timed_out" : "settled")) });
    await run(world, (captures) =>
      Effect.gen(function* () {
        yield* captures.videoStart(caller, videoParams);
        const timedOut = yield* captures.videoStop(stopCaller);
        expect(timedOut.isError).toBe(true);
        expect(JSON.stringify(timedOut.content)).toContain("Waited 60 s");
        expect([...world.artifacts.values()][0]?.capture._tag).toBe("Recording");
        expect(world.stops()).toBe(0);
        waiting = false;
        const stopped = yield* captures.videoStop(stopCaller);
        expect(stopped.isError).not.toBe(true);
        expect(JSON.stringify(stopped.content)).toContain("Waited for earlier screen_act calls");
        expect(world.stops()).toBe(1);
        expect(yield* captures.videoStop(stopCaller)).toEqual(stopped);
      }),
    );
  });
  it("pins start, stores a stopped MP4 and span once, and replays both calls", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const first = yield* captures.videoStart(caller, videoParams);
        expect(JSON.stringify(first.content)).toContain(
          "recording · stop with proof_video_stop within 60 s",
        );
        expect(yield* captures.videoStart(caller, videoParams)).toEqual(first);
        expect(world.starts()).toBe(1);
        expect(world.checkpoints()).toBe(1);
        const recording = [...world.artifacts.values()][0];
        expect(recording).toMatchObject({
          source: { _tag: "Checkpoint", ordinal: 4 },
          capture: { _tag: "Recording", screenId: SCREEN, fromSeq: 7 },
          launch: videoParams.launch,
          differences: videoParams.differences,
        });
        world.setSeq(12);
        const stopped = yield* captures.videoStop(stopCaller);
        yield* world.settled;
        expect(stopped.isError).not.toBe(true);
        expect(stopped.content).toHaveLength(1);
        expect(stopped.content[0]?.type).toBe("text");
        expect(JSON.stringify(stopped.content)).toContain("checkpoint #4 · observed");
        expect(yield* captures.videoStop(stopCaller)).toEqual(stopped);
        expect(yield* captures.videoStart(caller, videoParams)).toEqual(stopped);
        const stored = [...world.artifacts.values()][0];
        expect(stored?.capture).toMatchObject({
          _tag: "Video",
          span: { screenId: SCREEN, fromSeq: 7, toSeq: 12 },
          durationMs: 1_500,
          ending: "stopped",
        });
        if (stored?.capture._tag !== "Video") throw new Error("missing video");
        expect(world.blobs.get(stored.capture.media.blobKey)).toEqual(world.mp4);
        expect(stored.capture.media.sha256).toBe(
          createHash("sha256").update(world.mp4).digest("hex"),
        );
        expect(world.artifacts.size).toBe(1);
        expect(world.writes()).toBe(1);
        expect(world.stops()).toBe(1);
      }),
    );
  });

  it.each(["time-limit", "interrupted"] satisfies Array<ProofVideoEnding>)(
    "persists %s without stop and later returns the same artifact",
    async (ending) => {
      const world = fixture();
      await run(world, (captures) =>
        Effect.gen(function* () {
          yield* captures.videoStart(caller, videoParams);
          world.setSeq(9);
          yield* world.finish(ending);
          yield* world.settled;
          const stored = [...world.artifacts.values()][0];
          expect(stored?.capture).toMatchObject({ _tag: "Video", ending, span: { toSeq: 9 } });
          const stopped = yield* captures.videoStop(stopCaller);
          expect(JSON.stringify(stopped.content)).toContain(
            ending === "time-limit" ? "ended at the time limit" : "interrupted",
          );
          expect(world.stops()).toBe(0);
          expect(world.writes()).toBe(1);
        }),
      );
    },
  );

  it("records missing encoder once for a retried start", async () => {
    const world = fixture({ recorderRefusal: "no_encoder" });
    await run(world, (captures) =>
      Effect.gen(function* () {
        const first = yield* captures.videoStart(caller, videoParams);
        expect(yield* captures.videoStart(caller, videoParams)).toEqual(first);
        expect(JSON.stringify(first.content)).toContain(
          "not captured · this workspace has no screen video encoder",
        );
        expect([...world.artifacts.values()][0]?.capture).toEqual({
          _tag: "NotCaptured",
          kind: "video",
          reason: "this workspace has no screen video encoder",
        });
        expect(world.starts()).toBe(1);
        expect(world.artifacts.size).toBe(1);
        expect(world.writes()).toBe(0);
      }),
    );
  });

  it.each(["already_recording", "no_screen"] satisfies Array<RecorderRefusal["reason"]>)(
    "records nothing on recorder refusal %s",
    async (recorderRefusal) => {
      const world = fixture({ recorderRefusal });
      const answer = await run(world, (captures) => captures.videoStart(caller, videoParams));
      expect(answer.isError).toBe(true);
      expect(JSON.stringify(answer.content)).toContain(recorderRefusal);
      expect(world.artifacts.size).toBe(0);
    },
  );

  it.each([
    "owner_only",
    "unattributed_caller",
    "held",
    "no_screen",
  ] satisfies Array<ScreenRefusal>)("records nothing for caller refusal %s", async (refusal) => {
    const world = fixture({ refusal });
    await run(world, (captures) =>
      Effect.gen(function* () {
        expect((yield* captures.videoStart(caller, videoParams)).isError).toBe(true);
        expect((yield* captures.videoStop(stopCaller)).isError).toBe(true);
        expect(world.starts()).toBe(0);
        expect(world.artifacts.size).toBe(0);
      }),
    );
  });

  it("serializes concurrent duplicate starts", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const answers = yield* Effect.all(
          [captures.videoStart(caller, videoParams), captures.videoStart(caller, videoParams)],
          { concurrency: "unbounded" },
        );
        expect(answers[0]).toEqual(answers[1]);
        expect(world.starts()).toBe(1);
        yield* captures.videoStop(stopCaller);
      }),
    );
  });

  it("refuses stop with no recording", async () => {
    const world = fixture();
    const answer = await run(world, (captures) => captures.videoStop(stopCaller));
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain("no proof video recording to stop");
  });

  it.each([{ mediaUnavailable: true }, { blobFailed: true }])(
    "settles unavailable video and leaves the tools usable: %j",
    async (options) => {
      const world = fixture(options);
      await run(world, (captures) =>
        Effect.gen(function* () {
          yield* captures.videoStart(caller, videoParams);
          const answer = yield* captures.videoStop(stopCaller);
          yield* world.settled;
          expect([...world.artifacts.values()][0]?.capture).toMatchObject({
            _tag: "NotCaptured",
            kind: "video",
          });
          expect(answer.isError).toBe(true);
          expect(JSON.stringify(answer.content)).toContain("not captured");
          expect(yield* captures.videoStop(stopCaller)).toEqual(answer);
          expect(
            (yield* captures.missing(
              { ...caller, callKey: "missing" },
              { title: "Board", kind: "screenshot", reason: "No account" },
            )).isError,
          ).not.toBe(true);
        }),
      );
    },
  );

  it("stops the recorder when the artifact insert fails, and leaves capture usable", async () => {
    const world = fixture({ insertFailed: true });
    await run(world, (captures) =>
      Effect.gen(function* () {
        expect((yield* captures.videoStart(caller, videoParams)).isError).toBe(true);
        expect(world.stops()).toBe(1);
        expect(world.artifacts.size).toBe(0);
        expect(
          (yield* captures.screenshot({ ...caller, callKey: "retry" }, params)).isError,
        ).not.toBe(true);
      }),
    );
  });

  it("keeps video source unknown when checkpointing fails", async () => {
    const world = fixture({ checkpointFailed: true });
    await run(world, (captures) =>
      Effect.gen(function* () {
        yield* captures.videoStart(caller, videoParams);
        expect([...world.artifacts.values()][0]?.source).toMatchObject({ _tag: "Unknown" });
        yield* captures.videoStop(stopCaller);
      }),
    );
  });
});
