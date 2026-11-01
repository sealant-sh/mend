import { readFileSync } from "node:fs";

import {
  AgentConversationRepo,
  HarnessLayoutsRepo,
  makeScreensMemory,
  ScreensRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId, ViewerConnectionId } from "@mend/domain";
import { LinuxIdentity, SessionProcess, PROOF_LIMITS } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError, type ForwardRead } from "@mend/sealant";
import {
  ForwardAdapter,
  ScreenHost,
  ScreenHostLive,
  SessionEngine,
  ScreenRecorder,
  Screens,
  type RecordingScreen,
} from "@mend/sessions";
import { fakeWorkspace } from "@mend/sessions/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { InteractiveSession } from "@sealant/sdk";
import { Deferred, Effect, Exit, Fiber, Layer, Queue } from "effect";
import { BufferSource, Input, MP4 } from "mediabunny";
import { expect } from "vitest";

import { ScreenH264 } from "./screen-h264.ts";
import { ScreenRecorderLive } from "./screen-recorder.ts";
import { ScreenVideoSource, ScreenVideoSourceLive } from "./screen-video-source.ts";
import type { ScreenVideoFrame } from "./screen-video.ts";

const fixtureBytes = readFileSync(new URL("./test-fixtures/proof-baseline.h264", import.meta.url));
const delimiter = Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1]);
const units = new ScreenH264().push(Buffer.concat([fixtureBytes, delimiter]));
if (units === null || units[0] === undefined) throw new Error("fixture has no IDR");
const regionUnits = new ScreenH264().push(
  Buffer.concat([
    readFileSync(new URL("./test-fixtures/proof-region.h264", import.meta.url)),
    delimiter,
  ]),
);
if (regionUnits === null || regionUnits[0] === undefined)
  throw new Error("region fixture has no IDR");
const regionIdr = Buffer.from(regionUnits[0].data);
const regionDelta = Buffer.from(regionUnits[1]?.data ?? []);
const idr = Buffer.from(units[0].data);
const delta = Buffer.from(units[1]?.data ?? []);

const worldWith = (regionUnavailable = false) =>
  Effect.gen(function* () {
    const repo = makeScreensMemory();
    const reserved = yield* repo.reserve({
      sessionId: SessionId.make("proof-session"),
      workspaceId: SealantWorkspaceId.make("proof-workspace"),
    });
    const processId = SessionProcessId.make("proof-screen-process");
    const screen = yield* repo.setLife(reserved.id, {
      life: { _tag: "Live", degraded: null, browserSandboxOff: false },
      processId,
    });
    const input: RecordingScreen = {
      screenId: screen.id,
      sessionId: screen.sessionId,
      processId,
      display: screen.display,
    };
    const opens = yield* Queue.unbounded<{
      port: number;
      binding: unknown;
      bytes: Queue.Queue<ForwardRead>;
      closed: Deferred.Deferred<void>;
    }>();
    let openCount = 0;
    const forwards = Layer.mock(ForwardAdapter, {
      open: (target) =>
        Effect.gen(function* () {
          const bytes = yield* Queue.unbounded<ForwardRead>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          openCount++;
          yield* Queue.offer(opens, { port: target.port, binding: target.binding, bytes, closed });
          return {
            bytes: {
              read: () => Queue.take(bytes),
              write: () => Effect.void,
              finish: () => Effect.void,
              close: () => Effect.void,
            },
            record: {
              kind: "ready",
              dialId: "proof-test",
              purpose: "screen",
              workspaceId: target.workspaceId,
              port: target.port,
              requested: target.binding,
              lookupMs: 0,
              attempts: [],
              totalMs: 0,
              arrival: { route: "loopback", proof: target.binding },
            },
          };
        }),
    });
    const commands: Array<{ readonly argv: ReadonlyArray<string>; readonly user: unknown }> = [];
    const encoderClosed = yield* Deferred.make<void>();
    const pipe: InteractiveSession = {
      id: "region-pty",
      workspaceId: screen.workspaceId,
      runId: "region-run",
      mode: "pty",
      send: async () => {},
      resize: async () => {},
      signal: async () => {},
      output: async function* () {},
      status: async () => ({ status: "running", outputHighWater: 0n }),
      close: async () => {
        Deferred.doneUnsafe(encoderClosed, Exit.void);
      },
      attach: async () => {
        throw new Error("not attached");
      },
    };
    const row = new SessionProcess({
      id: processId,
      sessionId: screen.sessionId,
      sealantWorkspaceId: screen.workspaceId,
      sealantSessionId: "screen-pty",
      sealantRunId: null,
      launchCorrelationId: null,
      serviceId: null,
      attemptOrdinal: null,
      kind: "screen",
      harness: null,
      providerSessionId: null,
      protocolOptions: null,
      label: "screen",
      argv: [
        "sh",
        "-c",
        "screen",
        "mend-screen",
        `:${screen.display}`,
        "1280x800",
        "/run/user/40001/screen",
        "start",
      ],
      status: "running",
      exitCode: null,
      workspacePort: null,
      protocol: "tcp",
      hostPort: null,
      createdAt: new Date(),
      exitedAt: null,
      updatedAt: new Date(),
      runsAs: "proof-owner",
    });
    const host = Layer.effect(
      ScreenHost,
      Effect.map(ScreenHost, (real) => ({
        ...real,
        ownerOf: () => Effect.succeed("proof-owner"),
        ptyOf: () => Effect.succeed("screen-pty"),
      })),
    ).pipe(
      Layer.provide(
        ScreenHostLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionEngine, { launchUnderWay: () => false }),
              Layer.mock(SessionsRepo, {}),
              Layer.mock(SessionProcessesRepo, { byId: () => Effect.succeed(row) }),
              Layer.mock(AgentConversationRepo, {}),
              Layer.mock(HarnessLayoutsRepo, {
                identitiesOf: () =>
                  Effect.succeed([
                    new LinuxIdentity({
                      accountId: "proof-owner",
                      name: "proof-person",
                      uid: 40001,
                    }),
                  ]),
              }),
              Layer.mock(SealantClient, {
                getWorkspace: () => Effect.succeed(fakeWorkspace(screen.workspaceId)),
                openSession: (_workspace, argv, options) =>
                  Effect.suspend(() => {
                    commands.push({ argv, user: options?.user });
                    return regionUnavailable
                      ? Effect.fail(
                          new SealantPlatformError({
                            code: "unavailable",
                            message: "no ffmpeg",
                            status: null,
                            cause: null,
                          }),
                        )
                      : Effect.succeed(pipe);
                  }),
              }),
            ),
          ),
        ),
      ),
    );

    const screens = Layer.mock(Screens, {
      state: (id) =>
        Effect.map(repo.ofSession(id), (value) =>
          value === null ? null : { screen: value, takenAt: null },
        ),
    });
    const source = ScreenVideoSourceLive.pipe(
      Layer.provide(Layer.mergeAll(forwards, host, Layer.succeed(ScreensRepo, repo))),
    );
    const layer = ScreenRecorderLive.pipe(Layer.provideMerge(source), Layer.provide(screens));
    return {
      screen,
      input,
      repo,
      opens,
      layer,
      commands,
      encoderClosed,
      openCount: () => openCount,
    };
  });

const world = worldWith();

const send = (bytes: Queue.Queue<ForwardRead>, data = idr) =>
  Queue.offer(bytes, {
    kind: "bytes",
    bytes: Buffer.concat([data.subarray(6), delimiter]),
  });

it.effect(
  "records and streams to a viewer through one forward, surviving takeover and a viewer leaving",
  () =>
    Effect.gen(function* () {
      const f = yield* world;
      yield* Effect.gen(function* () {
        const recorder = yield* ScreenRecorder;
        const source = yield* ScreenVideoSource;
        const observed = yield* Queue.unbounded<ScreenVideoFrame>();
        const viewerReady = yield* Deferred.make<void>();
        const viewer = yield* Effect.forkScoped(
          Effect.scoped(
            Effect.gen(function* () {
              yield* source.subscribe(f.screen, {
                frame: (frame) => {
                  Queue.offerUnsafe(observed, frame);
                },
                ended: () => {},
              });
              yield* Deferred.succeed(viewerReady, undefined);
              yield* Effect.never;
            }),
          ),
        );
        const upstream = yield* Queue.take(f.opens);
        yield* send(upstream.bytes);
        yield* Deferred.await(viewerReady);
        yield* Queue.take(observed);
        const starting = yield* Effect.forkScoped(recorder.start(f.input));
        yield* Effect.yieldNow;
        yield* send(upstream.bytes);
        const id = yield* Fiber.join(starting);
        expect(f.openCount()).toBe(1);
        const duplicate = yield* recorder.start(f.input).pipe(Effect.result);
        expect(duplicate).toMatchObject({
          _tag: "Failure",
          failure: { reason: "already_recording" },
        });
        yield* Fiber.interrupt(viewer);
        expect(Deferred.isDoneUnsafe(upstream.closed)).toBe(false);
        yield* f.repo.control(
          f.screen.id,
          { _tag: "Take", by: "proof-owner", connection: ViewerConnectionId.make("holder") },
          "proof-owner",
        );
        // Fencing does not select the pointerless encoder until the hand has released input.
        const now = yield* f.repo.byId(f.screen.id);
        if (now?.input._tag !== "Fencing") throw new Error("takeover was not fenced");
        yield* f.repo.control(
          f.screen.id,
          { _tag: "Fenced", epoch: now.input.epoch },
          "proof-owner",
        );
        yield* TestClock.adjust("100 millis");
        const replacement = yield* Queue.take(f.opens);
        expect(replacement.port).toBe(8100 + f.screen.display);
        yield* send(replacement.bytes);
        yield* Deferred.await(upstream.closed);
        yield* send(replacement.bytes, delta);
        const result = yield* recorder.stop(id);
        expect(result.ending).toBe("stopped");
        expect(result.mp4.byteLength).toBeGreaterThan(0);
        yield* Deferred.await(replacement.closed);
        expect(f.openCount()).toBe(2);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("leaves an existing viewer streaming after the recorder releases its subscription", () =>
  Effect.gen(function* () {
    const f = yield* world;
    yield* Effect.gen(function* () {
      const recorder = yield* ScreenRecorder;
      const source = yield* ScreenVideoSource;
      const starting = yield* Effect.forkScoped(recorder.start(f.input));
      const upstream = yield* Queue.take(f.opens);
      yield* send(upstream.bytes);
      const id = yield* Fiber.join(starting);
      const observed = yield* Queue.unbounded<ScreenVideoFrame>();
      const viewerReady = yield* Deferred.make<void>();
      const viewer = yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            yield* source.subscribe(f.screen, {
              frame: (frame) => {
                Queue.offerUnsafe(observed, frame);
              },
              ended: () => {},
            });
            yield* Deferred.succeed(viewerReady, undefined);
            yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(viewerReady);
      yield* recorder.stop(id);
      expect(Deferred.isDoneUnsafe(upstream.closed)).toBe(false);
      yield* send(upstream.bytes, delta);
      expect((yield* Queue.take(observed)).data.byteLength).toBeGreaterThan(0);
      expect(f.openCount()).toBe(1);
      yield* Fiber.interrupt(viewer);
      yield* Deferred.await(upstream.closed);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "auto-finishes at the time limit without a viewer and exposes the result before collection",
  () =>
    Effect.gen(function* () {
      const f = yield* world;
      yield* Effect.gen(function* () {
        const recorder = yield* ScreenRecorder;
        const starting = yield* Effect.forkScoped(recorder.start(f.input));
        const upstream = yield* Queue.take(f.opens);
        yield* send(upstream.bytes);
        const id = yield* Fiber.join(starting);
        for (let elapsed = 0; elapsed < PROOF_LIMITS.videoMs; elapsed += 1000) {
          yield* send(upstream.bytes, delta);
          yield* TestClock.adjust(1000);
        }
        const finished = yield* recorder.onFinished(id);
        expect(finished.ending).toBe("time-limit");
        yield* Deferred.await(upstream.closed);
        expect(yield* recorder.stop(id)).toEqual(finished);
        expect(yield* recorder.stop(id).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not_found" },
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

for (const ending of ["upstream", "screen"] as const) {
  it.effect(`keeps a playable interrupted video when the ${ending} ends`, () =>
    Effect.gen(function* () {
      const f = yield* world;
      yield* Effect.gen(function* () {
        const recorder = yield* ScreenRecorder;
        const starting = yield* Effect.forkScoped(recorder.start(f.input));
        const upstream = yield* Queue.take(f.opens);
        yield* send(upstream.bytes);
        const id = yield* Fiber.join(starting);
        if (ending === "upstream") yield* Queue.offer(upstream.bytes, { kind: "eof" });
        else {
          yield* f.repo.release(f.screen.id);
          yield* TestClock.adjust("100 millis");
        }
        const result = yield* recorder.onFinished(id);
        expect(result.ending).toBe("interrupted");
        expect(result.mp4.byteLength).toBeGreaterThan(0);
        yield* Deferred.await(upstream.closed);
        yield* TestClock.adjust("10 minutes");
        expect(yield* recorder.stop(id).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "not_found" },
        });
      }).pipe(Effect.provide(f.layer));
    }),
  );
}

it.effect("refuses a missing screen and an encoder with no IDR within five seconds", () =>
  Effect.gen(function* () {
    const f = yield* world;
    yield* Effect.gen(function* () {
      const recorder = yield* ScreenRecorder;
      expect(
        yield* recorder
          .start({ ...f.input, processId: SessionProcessId.make("old") })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "no_screen" } });
      const starting = yield* Effect.forkScoped(recorder.start(f.input).pipe(Effect.result));
      const upstream = yield* Queue.take(f.opens);
      yield* send(upstream.bytes, delta);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(starting)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "no_encoder" },
      });
      yield* Deferred.await(upstream.closed);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("records a region through its own person encoder and session-bound forward", () =>
  Effect.gen(function* () {
    const f = yield* world;
    yield* Effect.gen(function* () {
      const recorder = yield* ScreenRecorder;
      const source = yield* ScreenVideoSource;
      const viewerReady = yield* Deferred.make<void>();
      const viewer = yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            yield* source.subscribe(f.screen, { frame: () => {}, ended: () => {} });
            yield* Deferred.succeed(viewerReady, undefined);
            yield* Effect.never;
          }),
        ),
      );
      const shared = yield* Queue.take(f.opens);
      yield* send(shared.bytes);
      yield* Deferred.await(viewerReady);
      const region = { x: 325, y: 205, width: 641, height: 301 };
      const starting = yield* Effect.forkScoped(recorder.start({ ...f.input, region }));
      const dedicated = yield* Queue.take(f.opens);
      expect(dedicated.port).toBe(8300 + f.screen.display);
      expect(dedicated.binding).toEqual({ kind: "session", session: "region-pty" });
      expect(f.commands).toHaveLength(1);
      expect(f.commands[0]?.user).toMatchObject({ name: "proof-person", uid: 40001 });
      expect(f.commands[0]?.argv.slice(4)).toEqual([
        `:${f.screen.display}`,
        "/run/user/40001/screen",
        "640x300",
        "325",
        "205",
        String(dedicated.port),
      ]);
      expect(f.commands[0]?.argv[2]).toContain('-i "$1+$4,$5"');
      expect(f.commands[0]?.argv[2]).toContain("-profile:v baseline");
      yield* send(dedicated.bytes, regionIdr);
      const id = yield* Fiber.join(starting);
      yield* send(dedicated.bytes, regionDelta);
      const result = yield* recorder.stop(id);
      expect(result.region).toEqual({ ...region, width: 640, height: 300 });
      const media = new Input({ formats: [MP4], source: new BufferSource(result.mp4) });
      try {
        const track = yield* Effect.promise(() => media.getPrimaryVideoTrack());
        expect(track?.codedWidth).toBe(640);
        expect(track?.codedHeight).toBe(300);
      } finally {
        media.dispose();
      }
      expect(result.ending).toBe("stopped");
      expect(result.mp4.byteLength).toBeGreaterThan(0);
      yield* Deferred.await(dedicated.closed);
      yield* Deferred.await(f.encoderClosed);
      expect(Deferred.isDoneUnsafe(shared.closed)).toBe(false);
      expect(f.openCount()).toBe(2);
      yield* Fiber.interrupt(viewer);
      yield* Deferred.await(shared.closed);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("falls back to a full-screen recording when the region encoder cannot start", () =>
  Effect.gen(function* () {
    const f = yield* worldWith(true);
    yield* Effect.gen(function* () {
      const recorder = yield* ScreenRecorder;
      const starting = yield* Effect.forkScoped(
        recorder.start({ ...f.input, region: { x: 320, y: 200, width: 640, height: 300 } }),
      );
      const upstream = yield* Queue.take(f.opens);
      expect(upstream.port).toBe(7900 + f.screen.display);
      yield* send(upstream.bytes);
      const id = yield* Fiber.join(starting);
      const result = yield* recorder.stop(id);
      expect(result.region).toBeNull();
      expect(result.ending).toBe("stopped");
      expect(result.mp4.byteLength).toBeGreaterThan(0);
      expect(f.commands).toHaveLength(1);
      yield* Deferred.await(upstream.closed);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("releases a region encoder without an IDR before falling back to the shared stream", () =>
  Effect.gen(function* () {
    const f = yield* world;
    yield* Effect.gen(function* () {
      const recorder = yield* ScreenRecorder;
      const starting = yield* Effect.forkScoped(
        recorder.start({ ...f.input, region: { x: 320, y: 200, width: 640, height: 300 } }),
      );
      const dedicated = yield* Queue.take(f.opens);
      yield* send(dedicated.bytes, delta);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(f.encoderClosed);
      yield* Deferred.await(dedicated.closed);
      const shared = yield* Queue.take(f.opens);
      expect(shared.port).toBe(7900 + f.screen.display);
      yield* send(shared.bytes);
      const id = yield* Fiber.join(starting);
      const result = yield* recorder.stop(id);
      expect(result.region).toBeNull();
      expect(result.ending).toBe("stopped");
      expect(result.mp4.byteLength).toBeGreaterThan(0);
      yield* Deferred.await(shared.closed);
    }).pipe(Effect.provide(f.layer));
  }),
);
