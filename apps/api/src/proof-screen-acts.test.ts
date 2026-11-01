import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentConversationRepo,
  makeScreensMemory,
  ProofArtifactsRepo,
  ScreensRepo,
  WorktreeChangesRepo,
} from "@mend/db";
import {
  ChangeId,
  ProjectId,
  type ProofArtifactId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ProofArtifact } from "@mend/domain/workbench";
import {
  type Caller,
  ForwardAdapterLive,
  ProofCaptures,
  ProofCapturesLive,
  ScreenHost,
  Screens,
  ScreensLive,
  screenWorkersLayer,
  SessionEngine,
} from "@mend/sessions";
import {
  dockerReady,
  makeScreenWorld,
  screenSealantLayer,
  startXvnc,
} from "@mend/sessions/testing";
import { BlobStore, BlobStoreFsLive, GitError } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { BufferSource, Input, MP4 } from "mediabunny";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { ScreenH264 } from "./screen-h264.ts";
import { ScreenRecorderLive } from "./screen-recorder.ts";
import { ScreenVideoSource } from "./screen-video-source.ts";

const sessionId = SessionId.make("proof-screen-acts");
const caller: Caller = {
  sessionId,
  accountId: "alice",
  agentProcess: { _tag: "Current", id: SessionProcessId.make("agent") },
  callKey: "start",
};
const change = new Change({
  id: ChangeId.make("change"),
  projectId: ProjectId.make("project"),
  worktreeId: WorktreeId.make("tree"),
  sessionId,
  baseSha: Sha.make("a".repeat(40)),
  branch: "proof/screen-acts",
  headSha: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const params = { title: "Move the pointer", caption: "The pointer reached the target." };
const fixture = readFileSync(new URL("./test-fixtures/proof-baseline.h264", import.meta.url));
const frames = new ScreenH264().push(
  Buffer.concat([fixture, Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1])]),
);
const firstFrame = frames?.[0];
if (firstFrame === undefined) throw new Error("missing video fixture IDR");

describe.skipIf(!dockerReady)("proof captures ordered behind real screen actions", () => {
  let xvnc: ReturnType<typeof startXvnc>;
  const root = mkdtempSync(join(tmpdir(), "proof-screen-acts-"));
  beforeAll(() => {
    xvnc = startXvnc(`proof-screen-acts-${process.pid}-${Date.now()}`);
  }, 660_000);
  afterAll(() => {
    xvnc?.remove();
    rmSync(root, { recursive: true, force: true });
  });

  const world = Effect.gen(function* () {
    const repo = makeScreensMemory();
    const screen = yield* repo.reserve({
      sessionId,
      workspaceId: SealantWorkspaceId.make("workspace"),
    });
    yield* repo.setLife(screen.id, {
      life: { _tag: "Live", degraded: null, browserSandboxOff: false },
      processId: SessionProcessId.make("screen"),
    });
    const accepted = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    const artifacts = new Map<ProofArtifactId, ProofArtifact>();
    const calls = new Map<string, ProofArtifactId>();
    const screenWorld = makeScreenWorld();
    screenWorld.xvncPort = xvnc.port;
    const blobs = BlobStoreFsLive(join(root, crypto.randomUUID()));
    const storedScreens = Layer.succeed(ScreensRepo, {
      ...repo,
      control: (id, event, owner, frame) =>
        Effect.gen(function* () {
          if (event._tag === "AgentActed") {
            yield* Deferred.succeed(accepted, undefined);
            yield* Deferred.await(proceed);
          }
          return yield* repo.control(id, event, owner, frame);
        }),
    });
    const screens = ScreensLive.pipe(
      Layer.provide(
        Layer.mock(ScreenHost, {
          ownerOf: () => Effect.succeed("alice"),
          passwords: () =>
            Effect.succeed({
              full: Redacted.make("handpass"),
              viewOnly: Redacted.make("handpass"),
            }),
          rekey: () => Effect.succeed(true),
          ptyOf: () => Effect.succeed("pty-screen"),
          turnOf: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(screenWorld)))),
      Layer.provide(screenWorkersLayer(new URL("./screen-worker.ts", import.meta.url))),
      Layer.provide(blobs),
      Layer.provideMerge(storedScreens),
    );
    // Real baseline H264 samples enter the real recorder at the live clock's cadence.
    const source = Layer.succeed(ScreenVideoSource, {
      subscribe: (_, subscriber) =>
        Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              subscriber.frame({ ...firstFrame, receivedAt: yield* Clock.currentTimeMillis });
              yield* Effect.sleep(50);
            }),
          ),
        ).pipe(Effect.asVoid),
    });
    const layer = ProofCapturesLive.pipe(
      Layer.provideMerge(ScreenRecorderLive.pipe(Layer.provide(source))),
      Layer.provideMerge(screens),
      Layer.provideMerge(blobs),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProofArtifactsRepo, {
            byCall: (_, key) =>
              Effect.sync(() => {
                const id = calls.get(key);
                return id === undefined ? null : (artifacts.get(id) ?? null);
              }),
            byId: (id) => Effect.sync(() => artifacts.get(id) ?? null),
            insert: (artifact, key) =>
              Effect.sync(() => {
                artifacts.set(artifact.id, artifact);
                if (key !== null) calls.set(key, artifact.id);
                return artifact;
              }),
            settleVideo: (id, capture) =>
              Effect.sync(() => {
                const previous = artifacts.get(id);
                if (previous === undefined) return null;
                if (previous.capture._tag !== "Recording") return previous;
                const saved = new ProofArtifact({ ...previous, capture, observedTo: new Date() });
                artifacts.set(id, saved);
                return saved;
              }),
          }),
          Layer.mock(WorktreeChangesRepo, { bySession: () => Effect.succeed(change) }),
          Layer.mock(AgentConversationRepo, { listTurns: () => Effect.succeed([]) }),
          Layer.mock(SessionEngine, {
            launchUnderWay: () => false,
            checkpointNow: () =>
              Effect.fail(
                new GitError({ args: [], cwd: "/repo", exitCode: 1, stderr: "no git fixture" }),
              ),
          }),
        ),
      ),
    );
    return { layer, artifacts, accepted, proceed, screen };
  });

  it.live("stores a playable video covering an act when stop arrives while the act runs", () =>
    Effect.gen(function* () {
      const w = yield* world;
      yield* Effect.gen(function* () {
        const screens = yield* Screens;
        const captures = yield* ProofCaptures;
        yield* screens.look({ ...caller, callKey: "look" });
        expect((yield* captures.videoStart(caller, params)).isError).not.toBe(true);
        yield* Deferred.succeed(w.proceed, undefined);
        const acting = yield* Effect.forkScoped(
          screens.act(
            { ...caller, callKey: "act" },
            {
              actions: [
                { kind: "wait", ms: 2_000 },
                { kind: "move", to: { x: 420, y: 321 } },
              ],
            },
          ),
        );
        yield* Deferred.await(w.accepted);
        yield* Effect.sleep(100);
        const stopped = yield* captures.videoStop({ ...caller, callKey: "stop" });
        const artifact = [...w.artifacts.values()][0];
        expect(artifact?.capture._tag).toBe("Video");
        if (artifact?.capture._tag !== "Video") throw new Error("no stored video");
        expect(artifact.capture.durationMs).toBeGreaterThanOrEqual(2_000);
        const act = yield* Fiber.join(acting);
        if (act._tag !== "Answered") throw new Error("act did not finish");
        expect(artifact.capture.span.toSeq).toBeGreaterThanOrEqual(act.receipt.seq);
        const bytes = yield* (yield* BlobStore).get(artifact.capture.media.blobKey);
        const input = new Input({ formats: [MP4], source: new BufferSource(bytes) });
        try {
          expect(yield* Effect.promise(() => input.computeDuration())).toBeGreaterThanOrEqual(2);
        } finally {
          input.dispose();
        }
        expect(JSON.stringify(stopped.content)).toContain("Waited for earlier screen_act calls");
      }).pipe(Effect.provide(w.layer));
    }),
  );

  it.live("captures a screenshot after an accepted act that has not sent input yet", () =>
    Effect.gen(function* () {
      const w = yield* world;
      yield* Effect.gen(function* () {
        const screens = yield* Screens;
        const captures = yield* ProofCaptures;
        yield* screens.look({ ...caller, callKey: "look" });
        const acting = yield* Effect.forkScoped(
          screens.act(
            { ...caller, callKey: "act" },
            {
              actions: [
                { kind: "wait", ms: 100 },
                { kind: "move", to: { x: 123, y: 456 } },
              ],
            },
          ),
        );
        yield* Deferred.await(w.accepted);
        const screenshot = yield* Effect.forkScoped(
          captures.screenshot({ ...caller, callKey: "shot" }, params),
        );
        yield* Effect.sleep(600);
        expect(screenshot.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(w.proceed, undefined);
        const answer = yield* Fiber.join(screenshot);
        const act = yield* Fiber.join(acting);
        const artifact = [...w.artifacts.values()][0];
        if (act._tag !== "Answered" || artifact?.capture._tag !== "Screenshot")
          throw new Error("missing capture");
        expect(artifact.capture.moment.seq).toBeGreaterThan(act.receipt.seq);
        expect(JSON.stringify(answer.content)).toContain("Waited for earlier screen_act calls");
      }).pipe(Effect.provide(w.layer));
    }),
  );
});
