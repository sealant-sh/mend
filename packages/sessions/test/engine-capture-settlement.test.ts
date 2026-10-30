import * as fs from "node:fs";
import * as path from "node:path";

import { type CaptureRow, CaptureStoreRepo } from "@mend/db";
import { SessionId, SessionProcessId, WorktreeId } from "@mend/domain";
import {
  AgentHookReport,
  Session,
  SessionProcess,
  captureDiscardAuditData,
  CAPTURE_SEAL_UNRESTORABLE,
  captureStatusLine,
} from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  SealantClient,
  SealantPlatformError,
  toPlatformError,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import {
  type CaptureChannel,
  CaptureGitVerifier,
  type GitVerification,
  type RegisterSealOutcome,
  type CaptureCompletionSeal,
  SessionEngine,
} from "@mend/sessions";
import { BlobStoreFsLive, captureKeys, sha256Hex } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import {
  type CreateOptions,
  type InteractiveSessionStatus,
  SealantApiError,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureStatus,
} from "@sealant/sdk";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Queue } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  CUSTOM_BASE,
  flushReport,
  launchOnce,
  provisionIn,
  leaseHeld,
  lifecycleLayer,
  memorySeals,
  shipHarnessCapture,
  until,
} from "./engine/capture-fixture.ts";
import { signalled, signalledFixture, watched } from "./engine/clock-fixture.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withEngine,
  withEngineEffect,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/** Drive the real channel's checkpoint wait without publishing a substitute capture. */
const registrationTimeouts = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const waiting = yield* Queue.unbounded<{
    readonly worktreeId: WorktreeId;
    readonly began: number;
    readonly timeout: Duration.Duration;
    readonly completed: Deferred.Deferred<CaptureRow | null>;
  }>();
  const wrap = (inner: CaptureChannel["Service"]): CaptureChannel["Service"] => ({
    ...inner,
    awaitRegister: (worktreeId, accept, timeout) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<CaptureRow | null>();
        yield* Queue.offer(waiting, {
          worktreeId,
          began: clock.currentTimeMillisUnsafe(),
          timeout,
          completed,
        });
        return yield* inner
          .awaitRegister(worktreeId, accept, timeout)
          .pipe(Effect.tap((registered) => Deferred.succeed(completed, registered)));
      }),
  });
  const expire = (worktreeId: WorktreeId) =>
    Effect.gen(function* () {
      const entered = yield* Queue.take(waiting);
      expect(entered.worktreeId).toBe(worktreeId);
      expect(Duration.toMillis(entered.timeout)).toBe(2000);
      yield* TestClock.adjust(1999);
      expect(yield* Deferred.isDone(entered.completed)).toBe(false);
      yield* TestClock.adjust(1);
      expect(yield* Deferred.await(entered.completed)).toBeNull();
      expect(clock.currentTimeMillisUnsafe() - entered.began).toBe(2000);
    });
  return { wrap, expire };
});

/** Observe the real flush requests made by one landing's four-attempt retry. */
const landingRetries = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const starts = yield* Effect.all(Array.from({ length: 4 }, () => Deferred.make<void>()));
  const attemptedAt: number[] = [];
  let recording = false;
  const record = Effect.gen(function* () {
    if (!recording) return;
    const started = starts[attemptedAt.length];
    if (started === undefined) return yield* Effect.die("landing made a fifth flush attempt");
    attemptedAt.push(clock.currentTimeMillisUnsafe());
    yield* Deferred.succeed(started, undefined);
  });
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      recording = true;
      const began = clock.currentTimeMillisUnsafe();
      const fiber = yield* Effect.forkChild(operation);
      for (const [index, started] of starts.entries()) {
        yield* Deferred.await(started);
        if (index < 3) {
          yield* TestClock.adjust(1999);
          expect(attemptedAt).toHaveLength(index + 1);
          yield* TestClock.adjust(1);
        }
      }
      const result = yield* Fiber.join(fiber);
      expect(attemptedAt.map((at) => at - began)).toEqual([0, 2000, 4000, 6000]);
      return result;
    }).pipe(Effect.ensuring(Effect.sync(() => (recording = false))));
  return { record, run };
});

/** A list the fake appends to, and a wait on it that wakes on each append instead of polling. */
const watchedList = <T>() =>
  Effect.map(Queue.unbounded<void>(), (appended) => ({
    items: watched<T>(appended),
    untilChanged: signalled(appended),
  }));

/**
 * A world whose session rows and relaunch plans signal every write (`signalledFixture`), with
 * the session rows in the order they were written: a wait on a row, or on a plan's clear, wakes
 * as it lands, never polls.
 */
const observedWorld = Effect.map(signalledFixture(), ({ fixture, untilChanged }) => {
  const rows: Array<Session> = [];
  const set = fixture.world.sessions.set.bind(fixture.world.sessions);
  fixture.world.sessions.set = (id, session) => {
    rows.push(session);
    return set(id, session);
  };
  return { fixture, rows, untilChanged };
});

/** `launchOnce` over a project adopted before the engine was built (`withPreparedEngineEffect`). */
describe("a Stop the person made in Mend (box, 2026-10-05)", () => {
  // On the box (0.36.0-next.601) the first Stop of a fresh session warned "the final flush
  // answered complete, but the executor's evidence does not read saved · stopped outside Mend" and
  // made a second final flush (5.1 s). A status read a client's view asked for just before the
  // Stop was still on its way: the executor answered it while Mend's own final flush ran
  // (`in-progress`), and the answer reached Mend after the final one. Until it was published the
  // evidence was not settled, so the drain asked for another final flush; and its `in-progress`
  // read as a final flush Mend did not ask for.
  it.effect(
    "makes one final flush and reads `stopped`, never `stopped outside Mend`, while a status read asked before it is still on its way",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const events = yield* watchedList<string>();
        const kinds: CaptureFlushKind[] = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const finalAnswered = yield* Deferred.make<void>();
        const statusAsked = yield* Deferred.make<void>();
        let statusReads = 0;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // The person's view asks for the executor's status as they press Stop.
              yield* engine.refreshCaptureStatus(session.id);
              yield* Deferred.await(statusAsked);
              yield* engine.stop(session.id);
              // The executor answers the status read 150 ms after the final flush; the drain,
              // waiting for that answer, looks every 25 ms (`EVIDENCE_SETTLE_LOOK`) and reads
              // the evidence settled on its next look.
              yield* Deferred.await(finalAnswered);
              yield* TestClock.adjust(Duration.millis(150));
              yield* TestClock.adjust(Duration.millis(25));
              yield* events.untilChanged(
                () => events.items.includes("workspace-1"),
                "the workspace stop",
              );
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle",
              );
              expect(kinds).toEqual(["final"]);
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.summary ?? "").not.toContain("stopped outside Mend");
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: { statusMinInterval: Duration.millis(0) },
            sealantLayer: lifecycleLayer(created, {
              events: events.items,
              captureOps: {
                flushed: events.items,
                flushKinds: kinds,
                flush: () =>
                  Effect.succeed(flushReport(0, 1, { headN: 1 })).pipe(
                    Effect.tap(() => Deferred.succeed(finalAnswered, undefined)),
                  ),
                // Answered while the final flush ran, before its answer (observation 0, the final's
                // is 1), and delivered after it.
                captureStatus: () =>
                  Effect.gen(function* () {
                    statusReads += 1;
                    if (statusReads === 1) yield* Deferred.succeed(statusAsked, undefined);
                    yield* Deferred.await(finalAnswered);
                    yield* Effect.sleep(Duration.millis(150));
                    const lease = [...memory.leases.values()].find(
                      (held) => held.executorId !== null,
                    );
                    const launch = lease?.launchId ?? null;
                    if (lease === undefined || launch === null) {
                      return yield* Effect.die("the executor's lease names no launch");
                    }
                    const running = { complete: false, incompleteReason: "in-progress" };
                    return {
                      ...flushReport(0, 1, { headN: 1 }),
                      ...running,
                      origin: {
                        epoch: lease.epoch,
                        launch,
                        bootId: "stand-in-boot",
                        bootGeneration: 1,
                        observation: 0,
                        headN: 1,
                      },
                    };
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("a review opened while a Stop ends the executor (packaged acceptance, arm64, 2026-10-10)", () => {
  // Release run 38011808256 (0.36.0-next.663): `POST /changes/:id/reviews/open` had no answer in
  // 120 s. The session was `stopping`: its drain had the final flush's answer (`final ·
  // completed`), read it saved and was terminating the executor. The review's checkpoint asked
  // that executor for another final flush and, once it answered, waited to publish the answer on
  // the executor's evidence permit, which the drain holds for as long as the platform takes to
  // answer the stop. The final flush the drain saved is the state to review: nothing more is asked.
  it.effect(
    "takes the review's checkpoint from the drain's saved final flush, without another flush and without waiting for the stop",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds: CaptureFlushKind[] = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              // The drain read the executor saved and asked the platform to stop it.
              yield* Deferred.await(stopAsked);
              expect(kinds).toEqual(["final"]);
              const head = memory.chains.get(session.worktreeId)?.headN ?? null;
              const taken = yield* engine
                .checkpointNow(session.id, "review-open")
                .pipe(Effect.timeoutOption(Duration.seconds(5)));
              expect(Option.isSome(taken)).toBe(true);
              // No flush of its own: the drain's final one stands for it.
              expect(kinds).toEqual(["final"]);
              // And it says so: the Stop's final save, its capture and when Mend received it —
              // never the checkpoint's own time as a fresh reading (round 2 of the review).
              if (Option.isSome(taken)) {
                const source = taken.value.source;
                expect(source?.kind).toBe("stop-final");
                expect(source?.captureN).toBe(1);
                expect(source?.observedAt.getTime()).toBeLessThanOrEqual(
                  taken.value.createdAt.getTime(),
                );
              }
              expect(memory.chains.get(session.worktreeId)?.headN ?? null).toBe(head);
              yield* Deferred.succeed(stopHeld, undefined);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle",
              );
              expect(world.sessions.get(session.id)?.status).toBe("stopped");
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds,
                flush: () => Effect.succeed(flushReport(0, 1, { headN: 1 })),
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
  it.effect(
    "waits for the drain's final flush still on its way and takes its word, never asking the executor again",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds = yield* watchedList<CaptureFlushKind>();
        const logs: Array<string> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const finalHeld = yield* Deferred.make<void>();
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* kinds.untilChanged(
                () => kinds.items.includes("final"),
                "the drain's final flush",
              );
              const review = yield* Effect.forkChild(
                engine.checkpointNow(session.id, "review-open"),
              );
              // The review looks at the drain every 50 ms (`DRAIN_WORD_LOOK`): four looks find
              // the final flush still on its way.
              yield* TestClock.adjust(Duration.millis(200));
              expect(review.pollUnsafe()).toBeUndefined();
              yield* Deferred.succeed(finalHeld, undefined);
              // The drain read it saved: the review's next look takes the drain's word, while the
              // platform's stop is still held.
              yield* TestClock.adjust(Duration.millis(50));
              const taken = yield* Fiber.join(review).pipe(
                Effect.timeoutOption(Duration.seconds(5)),
              );
              expect(Option.isSome(taken)).toBe(true);
              expect(kinds.items).toEqual(["final"]);
              expect(
                logs.some((line) =>
                  line.includes(
                    "checkpoint · review-open · from the Stop's final save · capture 1 · ",
                  ),
                ),
              ).toBe(true);
              yield* Deferred.await(stopAsked);
              yield* Deferred.succeed(stopHeld, undefined);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle",
              );
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            logs,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds.items,
                flush: () =>
                  Deferred.await(finalHeld).pipe(Effect.as(flushReport(0, 1, { headN: 1 }))),
                // Held until the review has taken the drain's word. The drain keeps that word
                // (`drainSaved`) only until the platform answers its stop; answered between two of
                // the review's 50 ms looks, the word is gone and the review reads the registered
                // head with no source. That is a race in the engine, reported with this change,
                // not an order this test may assume.
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
  // Review of mend#649 (Astra, 2026-10-10): the Stop's final save stands for a review's
  // checkpoint, never for a landing's barrier. A completed final may later answer `changed` (ADR
  // 0002 decision 7): the disk moved after the drain read it saved and while the platform was
  // still stopping the executor. A landing then must not take the old tree as caught up.
  it.effect(
    "never lands from the Stop's final save while the Stop is under way: the landing waits for it to settle",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds: CaptureFlushKind[] = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        let diskChanged = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* Deferred.await(stopAsked);
              diskChanged = true;
              const landing = yield* Effect.forkChild(
                engine.landingCheckpoint(session.id, "user-mark"),
              );
              yield* TestClock.adjust(Duration.seconds(2));
              // Neither the old tree nor a flush asked of the executor the Stop holds.
              expect(landing.pollUnsafe()).toBeUndefined();
              expect(kinds).toEqual(["final"]);
              // The Stop settles: the executor ended, its lease released. The landing reads the
              // chain as the Stop saved it, on its next look at the Stop.
              yield* Deferred.succeed(stopHeld, undefined);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the Stop to settle",
              );
              expect(landing.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(250));
              const taken = yield* Fiber.join(landing).pipe(
                Effect.timeoutOption(Duration.seconds(5)),
              );
              expect(Option.isSome(taken)).toBe(true);
              expect(kinds).toEqual(["final"]);
              expect(world.sessions.get(session.id)?.status).toBe("stopped");
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds,
                finalCompletion: "unreported",
                flush: () =>
                  Effect.succeed(
                    diskChanged
                      ? {
                          ...flushReport(0, 1, { headN: 1 }),
                          complete: false,
                          incompleteReason: "changed",
                          unreadable: 1,
                          unreadablePaths: ["last-work.txt"],
                        }
                      : { ...flushReport(0, 1, { headN: 1 }), complete: true },
                  ),
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "refuses a landing with `stopping` when the Stop has not settled within its wait",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds: CaptureFlushKind[] = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* Deferred.await(stopAsked);
              const landing = yield* Effect.forkChild(
                engine.landingCheckpoint(session.id, "user-mark").pipe(Effect.flip),
              );
              // The landing's wait (`landingStopWait`, 1 s here) runs out, not a moment before.
              yield* TestClock.adjust(999);
              expect(landing.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(1);
              const refused = yield* Fiber.join(landing).pipe(
                Effect.timeoutOption(Duration.seconds(5)),
              );
              expect(Option.isSome(refused)).toBe(true);
              if (Option.isSome(refused)) {
                expect(refused.value._tag).toBe("CapturesBehindError");
                if (refused.value._tag === "CapturesBehindError") {
                  expect(refused.value.stopping).toBe(true);
                }
              }
              expect(kinds).toEqual(["final"]);
              yield* Deferred.succeed(stopHeld, undefined);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle",
              );
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: { landingStopWait: Duration.seconds(1) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds,
                flush: () => Effect.succeed(flushReport(0, 1, { headN: 1 })),
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
  // Round 2 of the review of mend#649: requests and answers were ordered, and waits timed, by the
  // wall clock. Set back, it let a review take an answer the drain asked for before the review was
  // asked, and stretched a landing's wait by as much. Asks are a sequence now, and waits monotonic.
  it.effect(
    "never takes a drain's answer asked before the review, whatever the wall clock says",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const logs: string[] = [];
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        /** Every final flush the drain asked, as it is asked. */
        const asked = yield* Queue.unbounded<number>();
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        let asks = 0;
        yield* TestClock.setTime(Date.parse("2026-10-15T00:00:00Z"));
        const baseClock = yield* Clock.Clock;
        let wallOffset = 0;
        const wallClock: Clock.Clock = {
          ...baseClock,
          currentTimeMillisUnsafe: () => baseClock.currentTimeMillisUnsafe() + wallOffset,
          currentTimeMillis: Effect.sync(() => baseClock.currentTimeMillisUnsafe() + wallOffset),
        };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              expect(yield* Queue.take(asked)).toBe(1);
              wallOffset = -60_000;
              expect(wallClock.currentTimeMillisUnsafe()).toBe(
                baseClock.currentTimeMillisUnsafe() - 60_000,
              );
              expect(wallClock.currentTimeNanosUnsafe()).toBe(baseClock.currentTimeNanosUnsafe());
              const review = yield* Effect.forkChild(
                engine.checkpointNow(session.id, "review-open"),
              );
              // Two of the review's looks (`DRAIN_WORD_LOOK`, 50 ms) find no answer yet.
              yield* TestClock.adjust(Duration.millis(100));
              // The answer to the final asked before the review: in progress, not saved. The
              // drain asks again after its poll interval (10 ms).
              yield* Deferred.succeed(first, undefined);
              yield* TestClock.adjust(Duration.millis(10));
              expect(yield* Queue.take(asked)).toBe(2);
              // Ten more looks: an answer asked before the review is never taken.
              yield* TestClock.adjust(Duration.millis(500));
              expect(review.pollUnsafe()).toBeUndefined();
              expect(logs.some((line) => line.includes("checkpoint · review-open ·"))).toBe(false);
              // The final asked after the review saves: that is what the review takes, on its
              // next look, while the platform's stop is still held.
              yield* Deferred.succeed(second, undefined);
              yield* TestClock.adjust(Duration.millis(50));
              const taken = yield* Fiber.join(review).pipe(
                Effect.timeoutOption(Duration.seconds(5)),
              );
              expect(Option.isSome(taken)).toBe(true);
              if (Option.isSome(taken)) expect(taken.value.source?.kind).toBe("stop-final");
              // The review oracle is complete. Restore the wall clock before driving the
              // drain's remaining cleanup, whose saved-evidence dates also use wall time.
              wallOffset = 0;
              yield* TestClock.adjust(Duration.millis(10));
              yield* Deferred.await(stopAsked);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  wallOffset = 0;
                }).pipe(
                  Effect.andThen(Deferred.succeed(second, undefined)),
                  Effect.andThen(Deferred.succeed(stopHeld, undefined)),
                ),
              ),
            ),
          {
            captured: memory,
            logs,
            drainPolicy: { keptRetryFirst: Duration.millis(50), stallSeconds: 600 },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                finalCompletion: "unreported",
                flush: () =>
                  Effect.gen(function* () {
                    asks += 1;
                    const ask = asks;
                    yield* Queue.offer(asked, ask);
                    yield* Deferred.await(ask === 1 ? first : second);
                    return ask === 1
                      ? {
                          ...flushReport(1, 1, { headN: 1 }),
                          complete: false,
                          incompleteReason: "in-progress",
                        }
                      : { ...flushReport(0, 1, { headN: 1 }), complete: true };
                  }),
                // Held until the review has taken the drain's word: see the case above for the
                // engine race this stands in for.
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        ).pipe(Effect.provideService(Clock.Clock, wallClock));
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "refuses a landing when its wait is over, whatever the wall clock says",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const stopAsked = yield* Deferred.make<void>();
        const stopHeld = yield* Deferred.make<void>();
        yield* TestClock.setTime(Date.parse("2026-10-15T00:00:00Z"));
        const baseClock = yield* Clock.Clock;
        let wallOffset = 0;
        const wallClock: Clock.Clock = {
          ...baseClock,
          currentTimeMillisUnsafe: () => baseClock.currentTimeMillisUnsafe() + wallOffset,
          currentTimeMillis: Effect.sync(() => baseClock.currentTimeMillisUnsafe() + wallOffset),
        };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* Deferred.await(stopAsked);
              const landing = yield* Effect.forkChild(
                engine.landingCheckpoint(session.id, "user-mark").pipe(Effect.flip),
              );
              yield* TestClock.adjust(Duration.millis(100));
              wallOffset = -60_000;
              expect(wallClock.currentTimeMillisUnsafe()).toBe(
                baseClock.currentTimeMillisUnsafe() - 60_000,
              );
              expect(wallClock.currentTimeNanosUnsafe()).toBe(baseClock.currentTimeNanosUnsafe());
              // The wait (1 s) is over 900 ms later, whatever the wall clock was set back to.
              yield* TestClock.adjust(899);
              expect(landing.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(1);
              expect(landing.pollUnsafe()).toBeDefined();
              const refused = yield* Fiber.join(landing).pipe(
                Effect.timeoutOption(Duration.seconds(3)),
              );
              expect(Option.isSome(refused)).toBe(true);
              if (Option.isSome(refused) && refused.value._tag === "CapturesBehindError") {
                expect(refused.value.stopping).toBe(true);
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  wallOffset = 0;
                }).pipe(Effect.andThen(Deferred.succeed(stopHeld, undefined))),
              ),
            ),
          {
            captured: memory,
            drainPolicy: { landingStopWait: Duration.seconds(1) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flush: () => Effect.succeed(flushReport(0, 1, { headN: 1 })),
                aroundStop: () =>
                  Deferred.succeed(stopAsked, undefined).pipe(
                    Effect.andThen(Deferred.await(stopHeld)),
                  ),
              },
            }),
          },
        ).pipe(Effect.provideService(Clock.Clock, wallClock));
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine capture failures shown while they happen (e2e run 3, 2026-09-27)", () => {
  it.effect(
    "a final flush whose snapshot failed keeps the workspace at once, with sealantd's error and path, and asks again only on the kept backoff",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const events: string[] = [];
        const kinds = yield* watchedList<CaptureFlushKind>();
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        /** Every look the platform took at the workspace's status, in order. */
        const looks = yield* watchedList<"ready" | "stopped">();
        let shipped = 0;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              // The default stall window is 600 s: only a reason that cannot complete keeps it now.
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              const finals = () => kinds.items.filter((kind) => kind === "final").length;
              expect(finals()).toBe(1);
              const kept = world.sessions.get(session.id);
              expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
                "not saved · snapshot failed · EACCES: permission denied · unreadable tree/secrets.pem · 0 pending · workspace kept",
              );
              expect(events).not.toContain("workspace-1");
              expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
              // Nothing changed: the next sweep inside the first wait sends no FINAL.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(60));
              expect(finals()).toBe(1);
              // The first wait (`keptRetryFirst`, 300 ms from the kept reading) runs out, not a
              // moment before: then one more FINAL, kept again at once.
              yield* TestClock.adjust(Duration.millis(239));
              yield* engine.reapCaptureLeases();
              expect(finals()).toBe(1);
              yield* TestClock.adjust(Duration.millis(1));
              yield* engine.reapCaptureLeases();
              const looked = looks.items.length;
              yield* kinds.untilChanged(() => finals() > 1, "the retry after the first wait");
              // The round's drain looks at the executor after the harvest's FINAL and reuses its
              // answer: the next reap comes only once this round's sweep is under way, never
              // during its harvest (the reaper would fork a second sweep over it).
              yield* looks.untilChanged(
                () => looks.items.length > looked,
                "the drain's look in the retry",
              );
              yield* TestClock.adjust(Duration.millis(60));
              const afterRetry = finals();
              // Kept again at once: nothing more until the doubled wait, however many ticks.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(100));
              expect(finals()).toBe(afterRetry);
              expect(world.sessions.get(session.id)?.captureNotSavedAt).not.toBeNull();
              expect(events).not.toContain("workspace-1");
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              keptRetryFirst: Duration.millis(300),
              keptRetryMax: Duration.seconds(5),
            },
            sealantLayer: lifecycleLayer(created, {
              events,
              captureOps: {
                flushKinds: kinds.items,
                status: (stopAsked) => {
                  const status = stopAsked ? "stopped" : "ready";
                  looks.items.push(status);
                  return status;
                },
                // The daemon's own answer, as it gave it: its final snapshot failed.
                finalCompletion: "unreported",
                flush: () =>
                  Effect.sync(() => {
                    // Every round ships something (the counters grow): movement is not progress
                    // toward `complete` when the snapshot itself fails.
                    shipped += 1;
                    return {
                      ...flushReport(0, shipped),
                      complete: false,
                      incompleteReason: "snapshot-failed",
                      lastSnapError: "EACCES: permission denied",
                      unreadable: 1,
                      unreadablePaths: ["tree/secrets.pem"],
                    };
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  /**
   * Verify proof run 9 (2026-10-10): a shallow project's every capture failed git verification,
   * the registrar refused the final seal as unrestorable on each of 61 asks, and the Stop read
   * `saving` for 5 minutes, then `final seal not confirmed`. The executor registers a sealing
   * FINAL through the session's capture routes, Mend's verification answering as `verdict` says,
   * then the Stop's FINAL answers `sealing` over it.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const stopOverSealingFinal = (
    verdict: GitVerification,
    body: (at: {
      readonly world: World;
      readonly session: Session;
      readonly memory: MemoryCaptureStore;
      readonly finals: () => number;
      readonly events: ReadonlyArray<string>;
      readonly seal: RegisterSealOutcome | undefined;
      /** Wakes on every write to a session row. */
      readonly once: (condition: () => boolean, label: string) => Effect.Effect<void>;
      /** Wakes on every flush the platform was asked for. */
      readonly flushed: (condition: () => boolean, label: string) => Effect.Effect<void>;
    }) => Effect.Effect<void, unknown, SessionEngine>,
    // A row an older Mend recorded `failed` before this process checked it.
    staleFailedRow = false,
  ) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const events: string[] = [];
      const kinds = yield* watchedList<CaptureFlushKind>();
      const memory = makeMemoryCaptureStore();
      const observed = yield* observedWorld;
      let sealingHead: number | null = null;
      const verifier = Layer.succeed(CaptureGitVerifier, {
        verify: () => Effect.succeed(verdict),
        treePaths: () => Effect.succeed(null),
        treeObjects: () => Effect.succeed(null),
      });
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const lease = memory.leases.get(session.worktreeId);
            const chain = memory.chains.get(session.worktreeId);
            const launchId = lease?.launchId ?? null;
            if (lease === undefined || chain === undefined || launchId === null) {
              throw new Error("the launch holds no launch-bound lease");
            }
            const api = servedSocketApis.get(session.id)?.captureAs?.(launchId);
            if (api === undefined) throw new Error("no launch-bound capture routes");
            const tree = path.join(tmp, "sealing-final");
            fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
            fs.writeFileSync(path.join(tree, "tree", "edit.txt"), "the session's work\n");
            const keys = captureKeys(session.worktreeId, lease.epoch);
            const snapshot = snapshotDirectory(tree, keys, { chunkSize: 64 });
            const built = buildManifest({
              worktreeId: session.worktreeId,
              n: chain.headN + 1,
              parent: chain.headCapture,
              epoch: lease.epoch,
              seq: 50,
              kind: "final",
              git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
              workspace: { root: snapshot.root, packs: snapshot.packs },
              bulk: { root: "", packs: [], platform: "linux-x86_64" },
            });
            const manifest = {
              ...built.manifest,
              final_seal: { complete: true, epoch: lease.epoch, executor: launchId },
            };
            const bytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
            const id = sha256Hex(bytes);
            const key = keys.manifest(id);
            yield* uploadObjects(new Map([...snapshot.objects, [key, bytes]])).pipe(
              Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
            );
            const register = api.register({
              worktree_id: session.worktreeId,
              epoch: lease.epoch,
              n: manifest.n,
              parent: manifest.parent,
              capture_id: id,
              manifest_key: key,
              manifest: JSON.parse(JSON.stringify(manifest)),
            });
            let registered = yield* register;
            if (staleFailedRow) {
              const row = memory.captures.get(id);
              if (row === undefined) throw new Error("the sealing FINAL did not register");
              memory.captures.set(id, { ...row, gitFsck: "failed" });
              registered = yield* register;
            }
            sealingHead = manifest.n;
            yield* engine.stop(session.id);
            yield* body({
              world,
              session,
              memory,
              finals: () => kinds.items.filter((kind) => kind === "final").length,
              events,
              seal: registered.seal,
              once: observed.untilChanged,
              flushed: kinds.untilChanged,
            });
          }),
        {
          captured: memory,
          fixture: observed.fixture,
          verifier,
          drainPolicy: {
            pollInterval: Duration.millis(20),
            keptRetryFirst: Duration.seconds(30),
            keptRetryMax: Duration.seconds(30),
          },
          sealantLayer: lifecycleLayer(created, {
            events,
            captureOps: {
              flushKinds: kinds.items,
              finalCompletion: "unreported",
              // sealantd's own answer: everything registered, the seal not confirmed.
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 7),
                  headN: sealingHead ?? 0,
                  complete: false,
                  incompleteReason: "sealing",
                }),
            },
          }),
        },
      );
    });

  it.effect(
    "a final flush waiting on a seal Mend refused because this capture's git section failed verification reads not saved at once, says why, and keeps the workspace",
    () =>
      stopOverSealingFinal(
        { outcome: "failed", detail: "fatal: Failed to traverse parents of commit b67adf47" },
        ({ world, session, memory, finals, events, seal, once }) =>
          Effect.gen(function* () {
            expect(seal).toEqual({ state: "refused", reason: "unrestorable" });
            // The default stall window is 600 s: only the refused seal keeps it now.
            yield* once(
              () => world.sessions.get(session.id)?.captureNotSavedAt != null,
              "the kept workspace",
            );
            expect(finals()).toBe(1);
            const kept = world.sessions.get(session.id);
            expect(kept?.captureIncompleteReason).toBe(CAPTURE_SEAL_UNRESTORABLE);
            expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
              "not saved · final seal refused · git section failed verification · 0 pending · workspace kept",
            );
            expect(events).not.toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
          }),
      ),
    { timeout: 20_000 },
  );

  // Astra review of mend#654: a row an older Mend recorded `failed`, whose check cannot finish
  // now, is a seal withheld as unavailable, not refused: the Stop keeps its ordinary wait.
  it.effect(
    "a final flush waiting on a seal withheld because its check could not finish keeps saving, whatever the capture's row recorded before",
    () =>
      stopOverSealingFinal(
        {
          outcome: "unverified",
          detail: "index-pack --verify did not finish: signal SIGKILL",
          transient: true,
        },
        ({ world, session, memory, finals, events, seal, flushed }) =>
          Effect.gen(function* () {
            expect(seal).toEqual({ state: "withheld", reason: "unavailable" });
            // The drain asks again after every poll interval (20 ms here) while the seal is
            // withheld.
            for (const round of [1, 2, 3]) {
              if (round > 1) yield* TestClock.adjust(Duration.millis(20));
              yield* flushed(() => finals() >= round, `the drain asking again (${round})`);
            }
            const saving = world.sessions.get(session.id);
            expect(saving?.captureNotSavedAt).toBeNull();
            expect(saving?.captureIncompleteReason).toBe("sealing");
            expect(events).not.toContain("workspace-1");
            expect(leaseHeld(memory, session.worktreeId, session.id)).toBe(true);
          }),
        true,
      ),
    { timeout: 20_000 },
  );

  it.effect(
    "a running session whose snaps fail reads `capture failing since … · <error>` from a status read, and not once they succeed again",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const since = Date.parse("2026-09-27T16:29:51.000Z");
        let failing = true;
        let reads = 0;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              expect(world.sessions.get(session.id)?.status).toBe("running");
              // Nothing has read it yet: nothing to say.
              const before = world.sessions.get(session.id);
              expect(before === undefined ? "gone" : captureStatusLine(before)).toBeNull();
              // The reaper reads a running executor's status on its own.
              yield* engine.reapCaptureLeases();
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureFailingSince != null,
                "the failing snap on the session",
              );
              const shown = world.sessions.get(session.id);
              expect(shown === undefined ? null : captureStatusLine(shown)).toBe(
                "capture failing since 16:29:51 UTC · EIO: tree/db.sqlite",
              );
              // Within the interval the reaper does not ask again.
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(60));
              expect(reads).toBe(1);
              // A client's view asks (throttled per session); the snaps succeed again.
              failing = false;
              yield* engine.refreshCaptureStatus(session.id);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureFailingSince === null,
                "the failure cleared",
              );
              const cleared = world.sessions.get(session.id);
              expect(cleared === undefined ? "gone" : captureStatusLine(cleared)).toBeNull();
              expect(reads).toBe(2);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              statusInterval: Duration.minutes(1),
              statusMinInterval: Duration.millis(0),
            },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                captureStatus: () =>
                  Effect.sync(() => {
                    reads += 1;
                    return failing
                      ? {
                          ...flushReport(1, 1),
                          lastSnapError: "EIO: tree/db.sqlite",
                          snapFailingSinceUnixMs: since,
                          snapsFailed: 4,
                        }
                      : flushReport(0, 2);
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  // e2e8 F1: a capture deadlocked on a git pipe for 17 minutes while every status read `running ·
  // 0 pending`. sealantd now reports a step past its bound (`overdue`); Mend says so, and a
  // reading with one never reads saved.
  it.effect(
    "a running session whose capture step is past its bound reads `capture step overdue · <step> · …` from a status read, and not once it ends",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        let overdue = true;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.reapCaptureLeases();
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureOverdueStep != null,
                "the overdue step on the session",
              );
              const shown = world.sessions.get(session.id);
              expect(shown === undefined ? null : captureStatusLine(shown)).toBe(
                "capture step overdue · small snap › git cat-file --batch-check · running 17 min · bound 2 min",
              );
              expect(shown?.captureOverdueSince?.toISOString()).toBe("2026-09-28T06:54:14.000Z");
              // The step ended: nothing to say.
              overdue = false;
              yield* engine.refreshCaptureStatus(session.id);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureOverdueStep === null,
                "the overdue step cleared",
              );
              const cleared = world.sessions.get(session.id);
              expect(cleared === undefined ? "gone" : captureStatusLine(cleared)).toBeNull();
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              statusInterval: Duration.minutes(1),
              statusMinInterval: Duration.millis(0),
            },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                captureStatus: () =>
                  Effect.sync(() =>
                    overdue
                      ? {
                          ...flushReport(0, 1),
                          overdue: {
                            step: "small snap › git cat-file --batch-check",
                            startedUnixMs: Date.parse("2026-09-28T06:54:14.000Z"),
                            runningMs: 17 * 60_000 + 5_000,
                            boundMs: 120_000,
                          },
                        }
                      : flushReport(0, 2),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "after the owner's discard the session reads `stopped · unsaved work discarded by <name> at …`",
    () =>
      Effect.gen(function* () {
        const waits = yield* registrationTimeouts;
        const flushAsked = yield* Deferred.make<void>();
        let stopping = false;
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              stopping = true;
              yield* engine.stop(session.id);
              yield* Deferred.await(flushAsked);
              yield* TestClock.adjust(999);
              expect(world.sessions.get(session.id)?.captureNotSavedAt).toBeNull();
              yield* TestClock.adjust(1);
              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                  "the kept workspace after the real flush",
                ),
              );
              const discarding = yield* engine
                .discardUnsavedAndStop(session.id, "Ada Lovelace")
                .pipe(Effect.forkChild);
              yield* waits.expire(session.worktreeId);
              yield* waits.expire(session.worktreeId);
              yield* Fiber.join(discarding);
              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(session.id)?.settledAt != null,
                  "the settle after the discard",
                ),
              );
              const settled = world.sessions.get(session.id);
              if (settled === undefined) throw new Error("the session went");
              const line = captureStatusLine(settled);
              expect(`${settled.status} · ${line}`).toMatch(
                /^stopped · unsaved work discarded by Ada Lovelace at \d\d:\d\d:\d\d UTC$/,
              );
            }),
          {
            captured: memory,
            wrapCaptureChannel: waits.wrap,
            drainPolicy: { stallSeconds: 1, terminationWait: Duration.millis(300) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: (discard) => (discard ? "stopped" : "kept"),
                flush: () =>
                  Effect.gen(function* () {
                    if (stopping) yield* Deferred.succeed(flushAsked, undefined);
                    return flushReport(2, 1);
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine lifecycle after a final flush (e2e run 4, 2026-09-27)", () => {
  /** A daemon's status once its final flush completed (sealantd 0.19: `complete` on status). */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const completedStatus = (headN: number): WorkspaceCaptureStatus => {
    const completion = { complete: true };
    return { ...flushReport(0, headN, { headN }), ...completion };
  };

  /**
   * The M3 sequence: `sealantctl capture flush --final` inside the executor ends the harness and
   * closes admission (an exec there is refused), the daemon waits for its stop; Mend's stop then
   * flushes, and each suspend flush stages a capture on top of the final (the sealantd side is
   * fixed in parallel); the drain's FINAL completes and the workspace is terminated.
   */
  const m3 =
    (statusAnswers: boolean, finishedTurn = false) =>
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const created: Array<CreateOptions> = [];
        const events = yield* watchedList<string>();
        const kinds: CaptureFlushKind[] = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const firstLook = yield* Deferred.make<void>();
        let dir = "";
        let finalRan = false;
        let firstLookAt: number | null = null;
        let worktree: WorktreeId | null = null;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              dir = tmp;
              const { engine, session } = yield* provisionIn(project);
              worktree = session.worktreeId;
              yield* engine.launch(session.id, ["codex"]);
              /** Every status the session's row went through, one entry per change. */
              const seen = () =>
                observed.rows
                  .filter((row) => row.id === session.id)
                  .map((row) => row.status)
                  .filter((status, index, all) => index === 0 || all[index - 1] !== status);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              yield* shipHarnessCapture(tmp, memory, session.worktreeId, epoch, "m3", "final");
              finalRan = true;
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              const before = finishedTurn ? "idle" : "running";
              if (finishedTurn) {
                const hook = servedSocketApis.get(session.id)?.agentHook;
                if (hook === undefined) throw new Error("the session serves no channel");
                for (const event of ["SessionStart", "Stop"]) {
                  yield* hook(
                    new AgentHookReport({
                      harness: "codex",
                      event,
                      notificationType: null,
                      tool: null,
                      providerSessionId: "codex-thread",
                    }),
                  );
                }
              }
              expect(world.sessions.get(session.id)?.status).toBe(before);
              // The final flush terminated the harness.
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 143,
                outputHighWater: 0n,
              });
              // The watcher's next look at the PTY (every 2 s) finds the harness gone.
              yield* TestClock.adjust(1999);
              expect(firstLookAt).toBeNull();
              yield* TestClock.adjust(1);
              yield* Deferred.await(firstLook);
              // The harness is gone: the line leaves `running` (or a finished turn's `idle`) at
              // once, not after the looks.
              yield* observed.untilChanged(
                () =>
                  world.sessions.get(session.id)?.status !== before &&
                  clock.currentTimeMillisUnsafe() - (firstLookAt ?? 0) < 1000,
                "the session leaving `running` within a second of the harness going",
              );
              if (statusAnswers) {
                // The executor's status says its final flush completed: that is the end reading.
                yield* observed.untilChanged(
                  () => world.sessions.get(session.id)?.settledAt != null,
                  "the settle on the executor's word",
                );
                expect(world.sessions.get(session.id)?.status).toBe("stopped");
                expect(world.sessions.get(session.id)?.summary).toMatch(
                  /^stopped outside Mend · saved at \d\d:\d\d:\d\d UTC · capture \d+$/,
                );
              } else {
                // Nothing says yet how the executor ended: `stopping`, never `running`.
                expect(world.sessions.get(session.id)?.status).toBe("stopping");
              }
              // The owner's stop, while the watcher may still be looking.
              yield* engine.stop(session.id);
              yield* events.untilChanged(
                () => events.items.includes("workspace-1"),
                "the workspace stop",
              );
              yield* observed.untilChanged(() => {
                const current = world.sessions.get(session.id);
                return current?.settledAt != null && current.captureDrain === null;
              }, "the settle");
              // Past every look the watcher could still take.
              yield* TestClock.adjust(Duration.millis(1500));
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.summary ?? "").not.toMatch(/executor lost/);
              expect(seen()).not.toContain("failed");
              expect(kinds).toContain("final");
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              pollInterval: Duration.seconds(1),
              terminationWait: Duration.seconds(3),
            },
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              events.items,
              undefined,
              undefined,
              undefined,
              ptyStates,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                flushKinds: kinds,
                // Admission is closed once the final ran: nothing is exec'd there.
                exec: (argv) => {
                  if (argv.length !== 1 || argv[0] !== "true") return undefined;
                  if (!finalRan) return { exitCode: 0, stdout: "", stderr: "" };
                  if (firstLookAt === null) {
                    firstLookAt = clock.currentTimeMillisUnsafe();
                    Deferred.doneUnsafe(firstLook, Effect.void);
                  }
                  return { exitCode: 1, stdout: "", stderr: "admission closed" };
                },
                flush: () =>
                  Effect.gen(function* () {
                    // A suspend flush after the final stages a capture on top of it.
                    if (kinds.at(-1) === "suspend" && finalRan && worktree !== null) {
                      const epoch = memory.leases.get(worktree)?.epoch ?? 0;
                      yield* shipHarnessCapture(
                        dir,
                        memory,
                        worktree,
                        epoch,
                        crypto.randomUUID(),
                        "suspend",
                      ).pipe(Effect.orDie);
                    }
                    const headN = worktree === null ? 0 : (memory.chains.get(worktree)?.headN ?? 0);
                    return finalRan ? completedStatus(headN) : flushReport(0, headN);
                  }),
                ...(statusAnswers
                  ? {
                      captureStatus: () =>
                        Effect.sync(() => {
                          const headN =
                            worktree === null ? 0 : (memory.chains.get(worktree)?.headN ?? 0);
                          return finalRan ? completedStatus(headN) : flushReport(0, headN);
                        }),
                    }
                  : {}),
              },
            ),
          },
        );
      });

  it.effect(
    "a final flush run inside the executor, then Mend's stop: the executor's `complete` is the save, the line leaves `running` at once, and it ends `stopped`, never `failed · executor lost`",
    m3(true),
    { timeout: 30_000 },
  );

  it.effect(
    "the same with no status read (an older SDK): the stop's drain is re-checked on every look, and a settled `stopped` is never overwritten with `failed`",
    m3(false),
    { timeout: 30_000 },
  );

  it.effect(
    "the same after the agent finished its turn: the harness going moves `idle` to `stopping` at once",
    m3(false, true),
    { timeout: 30_000 },
  );

  it.effect(
    "decision 7: a final flush that answers `changed` is not saved; the drain asks again and ends the executor only on a completed answer",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds = yield* watchedList<CaptureFlushKind>();
        /** Every look the platform took at the workspace's status, in order. */
        const looks = yield* watchedList<"ready" | "stopped">();
        const stops = yield* watchedList<"drain" | "discard">();
        const memory = makeMemoryCaptureStore();
        let answered = 0;
        let answeredAtStop = -1;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const looked = looks.items.length;
              yield* engine.stop(session.id);
              // The first FINAL answers `changed`, and the drain, looking at the executor, reads
              // it: not saved. It asks again after its poll interval (10 ms).
              yield* kinds.untilChanged(
                () => kinds.items.includes("final"),
                "the first final flush",
              );
              yield* looks.untilChanged(() => looks.items.length > looked, "the drain's look");
              yield* TestClock.adjust(Duration.millis(10));
              yield* stops.untilChanged(() => stops.items.length > 0, "the stop");
              expect(answeredAtStop).toBeGreaterThanOrEqual(2);
              expect(world.sessions.get(session.id)?.captureNotSavedAt ?? null).toBeNull();
            }),
          {
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds.items,
                stops: stops.items,
                status: (stopAsked) => {
                  const status = stopAsked ? "stopped" : "ready";
                  looks.items.push(status);
                  return status;
                },
                stopAnswer: () => {
                  answeredAtStop = answered;
                  return "stopped";
                },
                finalCompletion: "unreported",
                flush: () =>
                  Effect.sync(() => {
                    answered += 1;
                    return answered === 1
                      ? { ...flushReport(0, 1), complete: false, incompleteReason: "changed" }
                      : { ...flushReport(0, 1), complete: true };
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "decision 7: a completed FINAL answered a moment ago is asked again before the executor ends: complete means current",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds = yield* watchedList<CaptureFlushKind>();
        const stops: Array<"drain" | "discard"> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const finals = () => kinds.items.filter((kind) => kind === "final").length;
        let round = false;
        let inRound = 0;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              // The kept round: its first FINAL (the settle harvest's) completes, then the disk
              // changes. The drain does not end the executor on the harvest's answer: it asks again
              // and hears `changed`.
              round = true;
              const before = finals();
              // Past the kept drain's wait (`keptRetryFirst`, 300 ms).
              yield* TestClock.adjust(Duration.millis(300));
              yield* engine.reapCaptureLeases();
              yield* kinds.untilChanged(() => finals() - before >= 2, "the kept round's FINALs");
              // Every further answer is `changed`, asked every poll interval: nothing stops.
              yield* TestClock.adjust(Duration.millis(200));
              expect(stops).toEqual([]);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              keptRetryFirst: Duration.millis(300),
              keptRetryMax: Duration.seconds(5),
            },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds.items,
                stops,
                finalCompletion: "unreported",
                flush: () =>
                  Effect.sync(() => {
                    if (!round) {
                      return {
                        ...flushReport(0, 1),
                        complete: false,
                        incompleteReason: "snapshot-failed",
                        lastSnapError: "EACCES: permission denied",
                      };
                    }
                    inRound += 1;
                    return inRound === 1
                      ? { ...flushReport(0, 1), complete: true }
                      : { ...flushReport(0, 1), complete: false, incompleteReason: "changed" };
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a stop's deferred checkpoint that runs out of time keeps the saved executor for the next round, which runs it before the stop",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        /** Flushes and stops in the order the platform saw them. */
        const events = yield* watchedList<string>();
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        let release: (() => void) | null = null;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const marks = () =>
                world.checkpoints.filter(
                  (c) => c.worktreeId === session.worktreeId && c.trigger === "user-mark",
                ).length;
              // The checkpoint store does not answer: the stop's user mark, put off to the final
              // flush, waits on it past the limit. The executor is saved and kept, not stopped:
              // its lease never goes under work still owed (Astra review, 2026-10-03).
              world.checkpointHold.current = new Promise<void>((resolve) => {
                release = resolve;
              });
              yield* engine.stop(session.id);
              yield* events.untilChanged(
                () => events.items.includes("flush:workspace-1"),
                "the final flush",
              );
              // The mark runs past its limit (`deferredWorkLimit`, 200 ms), not a moment before.
              yield* TestClock.adjust(Duration.millis(199));
              expect(world.sessions.get(session.id)?.captureNotSavedAt ?? null).toBeNull();
              yield* TestClock.adjust(Duration.millis(1));
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              expect(events.items).toEqual(["flush:workspace-1"]);
              expect(marks()).toBe(0);
              // The store answers. The next round, past the kept drain's wait (`keptRetryFirst`,
              // 300 ms), saves again, runs the mark it was owed, then stops the executor.
              world.checkpointHold.current = null;
              release?.();
              yield* TestClock.adjust(Duration.millis(300));
              yield* engine.reapCaptureLeases();
              yield* events.untilChanged(
                () => events.items.includes("workspace-1"),
                "the workspace stop",
              );
              expect(events.items.at(-1)).toBe("workspace-1");
              expect(marks()).toBe(1);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              deferredWorkLimit: Duration.millis(200),
              keptRetryFirst: Duration.millis(300),
              keptRetryMax: Duration.seconds(5),
            },
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              events.items,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { flushed: events.items },
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a kept round sends one FINAL: the settle harvest reuses the drain's answer",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const kinds = yield* watchedList<CaptureFlushKind>();
        /** Every look the platform took at the workspace's status, in order. */
        const looks = yield* watchedList<"ready" | "stopped">();
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept workspace",
              );
              yield* TestClock.adjust(Duration.millis(100));
              const finals = () => kinds.items.filter((kind) => kind === "final").length;
              expect(finals()).toBe(1);
              for (const round of [1, 2]) {
                // Past the kept drain's wait (`keptRetryFirst`, doubled each unchanged round).
                yield* TestClock.adjust(Duration.millis(350 * round));
                const before = finals();
                yield* engine.reapCaptureLeases();
                yield* kinds.untilChanged(() => finals() > before, `kept round ${round}`);
                // The round's drain looks at the executor after the harvest's FINAL and reuses its
                // answer: the next round's reap comes only once this round's sweep is over.
                const looked = looks.items.length;
                yield* looks.untilChanged(
                  () => looks.items.length > looked,
                  `the drain's look in kept round ${round}`,
                );
                yield* TestClock.adjust(Duration.millis(200));
                expect(finals() - before, `FINALs in kept round ${round}`).toBe(1);
              }
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            drainPolicy: {
              keptRetryFirst: Duration.millis(300),
              keptRetryMax: Duration.seconds(5),
            },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                flushKinds: kinds.items,
                status: (stopAsked) => {
                  const status = stopAsked ? "stopped" : "ready";
                  looks.items.push(status);
                  return status;
                },
                finalCompletion: "unreported",
                flush: () =>
                  Effect.succeed({
                    ...flushReport(0, 1),
                    complete: false,
                    incompleteReason: "snapshot-failed",
                    lastSnapError: "EACCES: permission denied",
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a discard records what Mend knows — last save, snaps failing since, the error, no completed final — and the line's time is when it was asked",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const waits = yield* registrationTimeouts;
        const flushAsked = yield* Deferred.make<void>();
        let stopping = false;
        const discardAsked = yield* Deferred.make<void>();
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const failingSince = Date.parse("2026-09-27T19:55:02.000Z");
        let stopAskedAt: number | null = null;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const saved = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
                "auto",
              );
              stopping = true;
              yield* engine.stop(session.id);
              yield* Deferred.await(flushAsked);

              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                  "the kept workspace after the real flush",
                ),
              );
              const askedAt = clock.currentTimeMillisUnsafe();
              const discarding = yield* engine
                .discardUnsavedAndStop(session.id, "Ada Lovelace")
                .pipe(Effect.forkChild);
              yield* waits.expire(session.worktreeId);
              yield* waits.expire(session.worktreeId);
              yield* Deferred.await(discardAsked);
              yield* TestClock.adjust(Duration.millis(300));
              expect(discarding.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(10));
              const result = yield* Fiber.join(discarding);
              const { facts, discardedAt } = result;
              if (discardedAt === null) return expect.fail("the discard discarded nothing");
              expect(facts.requestedAt.getTime()).toBeGreaterThanOrEqual(askedAt);
              expect(discardedAt.getTime() - facts.requestedAt.getTime()).toBeGreaterThan(250);
              expect(facts.lastSaved?.n).toBe(saved.manifest.n);
              expect(facts.failingSince?.getTime()).toBe(failingSince);
              expect(facts.failingError).toBe("EACCES: permission denied");
              expect(facts.finalCompleted).toBeNull();
              expect(facts.queue?.pending).toBe(0);
              expect(facts.workspaceId).toBe("workspace-1");
              // What the audit keeps: no `0 pending` for edits a failing snap never staged.
              const data = captureDiscardAuditData(facts, discardedAt);
              expect(data["pending"]).toBeNull();
              expect(data["lastSavedN"]).toBe(saved.manifest.n);
              expect(data["finalCompleted"]).toBe(false);
              yield* TestClock.withLive(
                until(
                  () => world.sessions.get(session.id)?.settledAt != null,
                  "the settle after the discard",
                ),
              );
              // The line says when the discard was asked, not when it was recorded.
              expect(world.sessions.get(session.id)?.captureDiscardedAt?.getTime()).toBe(
                facts.requestedAt.getTime(),
              );
            }),
          {
            captured: memory,
            wrapCaptureChannel: waits.wrap,
            drainPolicy: { terminationWait: Duration.seconds(3) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: (discard) => {
                  if (discard) {
                    stopAskedAt ??= clock.currentTimeMillisUnsafe();
                    Deferred.doneUnsafe(discardAsked, Effect.void);
                  }
                  return discard ? "requested" : "kept";
                },
                // The discarding stop takes a moment to be observed.
                status: () =>
                  stopAskedAt !== null && clock.currentTimeMillisUnsafe() - stopAskedAt > 300
                    ? "stopped"
                    : "ready",
                finalCompletion: "unreported",
                flush: () =>
                  Effect.gen(function* () {
                    if (stopping) yield* Deferred.succeed(flushAsked, undefined);
                    return {
                      ...flushReport(0, 1),
                      complete: false,
                      incompleteReason: "snapshot-failed",
                      lastSnapError: "EACCES: permission denied",
                      snapFailingSinceUnixMs: failingSince,
                    };
                  }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );
});

describe("SessionEngine lifecycle, second review (2026-09-28)", () => {
  it.effect(
    "#13 a `docker stop` whose sealed final capture registered last reads saved, from the store's seal for that executor and epoch",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const observed = yield* observedWorld;
        let stopped = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const built = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                crypto.randomUUID(),
                "final",
              );
              // A seal another epoch holds says nothing of this executor.
              records.set(`${session.worktreeId}:${epoch + 1}`, {
                worktreeId: session.worktreeId,
                epoch: epoch + 1,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(),
              });
              records.set(`${session.worktreeId}:${epoch}`, {
                worktreeId: session.worktreeId,
                epoch,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(),
              });
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              stopped = true;
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The watcher's next look at the PTY (every 2 s) finds the harness gone.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.summary).toBe(
                `stopped outside Mend · saved at ${records
                  .get(`${session.worktreeId}:${epoch}`)
                  ?.sealedAt.toISOString()
                  .slice(11, 19)} UTC · capture ${built.manifest.n}`,
              );
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            seals: memorySeals(records),
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              () => stopped,
              undefined,
              ptyStates,
            ),
          },
        );
      }),
    { timeout: 20_000 },
  );

  /**
   * e2e9 F-A: a `docker stop` outside Mend whose FINAL saved (the seal stood). Core then reports
   * the workspace `failed` ("exited on its own (exitCode: 0)"), its container removed, its drain
   * `stopped` — and Mend read every non-live status but `stopped` as kept, so the session read
   * `stopping` for good. `drain`: what Core's `captureDrain()` answers once the executor ended.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const dockerStopReportedFailed = (
    drain: WorkspaceCaptureDrain,
    endReadAfter: Duration.Duration,
  ) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const ptyStates = new Map<string, InteractiveSessionStatus>();
      const memory = makeMemoryCaptureStore();
      const records = new Map<string, CaptureCompletionSeal>();
      const rows = yield* observedWorld;
      let exited = false;
      let observed: { readonly status: string | undefined; readonly summary: string | null } = {
        status: undefined,
        summary: null,
      };
      let expectedSaved = "";
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const built = yield* shipHarnessCapture(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              crypto.randomUUID(),
              "final",
            );
            const sealedAt = new Date();
            records.set(`${session.worktreeId}:${epoch}`, {
              worktreeId: session.worktreeId,
              epoch,
              executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
              captureId: built.id,
              n: built.manifest.n,
              sealedAt,
            });
            expectedSaved = `stopped outside Mend · saved at ${sealedAt.toISOString().slice(11, 19)} UTC · capture ${built.manifest.n}`;
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent === undefined || agent.sealantSessionId === null) {
              throw new Error("the launch recorded no agent PTY");
            }
            exited = true;
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 0,
              outputHighWater: 0n,
            });
            // The watcher's next look at the PTY (every 2 s) finds the harness gone; the end is
            // read `endReadAfter` later, and not a moment before.
            yield* TestClock.adjust(Duration.seconds(2));
            if (Duration.toMillis(endReadAfter) > 0) {
              yield* TestClock.adjust(Duration.subtract(endReadAfter, Duration.millis(1)));
              expect(world.sessions.get(session.id)?.settledAt ?? null).toBeNull();
              yield* TestClock.adjust(Duration.millis(1));
            }
            yield* rows.untilChanged(
              () => world.sessions.get(session.id)?.settledAt != null,
              "the end to be read",
            );
            const read = world.sessions.get(session.id);
            observed = { status: read?.status, summary: read?.summary ?? null };
          }),
        {
          captured: memory,
          fixture: rows.fixture,
          seals: memorySeals(records),
          drainPolicy: { terminationWait: Duration.millis(50) },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              status: () => (exited ? "failed" : "ready"),
              captureDrain: () => (exited ? drain : null),
            },
          ),
        },
      );
      return { ...observed, expectedSaved };
    });

  it.effect(
    "e2e9 F-A: a `docker stop` that saved, which Core reports `failed` with its drain `stopped` and nothing retained, settles `stopped outside Mend · saved at …` — never `stopping` for good",
    () =>
      Effect.gen(function* () {
        // Gone on the first look: the end is read at once.
        const read = yield* dockerStopReportedFailed(
          {
            state: "stopped",
            detail: "exited on its own (exitCode: 0)",
          },
          Duration.zero,
        );
        // Before: `stopping`, for good.
        expect(read.status).toBe("stopped");
        expect(read.summary).toBe(read.expectedSaved);
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "e2e9 F-A: an executor Core reports `failed` but retains for recovery still reads kept, never stopped",
    () =>
      Effect.gen(function* () {
        // Kept, so no look answers: the end is read after the five further looks, 10 ms apart.
        const read = yield* dockerStopReportedFailed(
          {
            state: "kept",
            retained: {
              since: "2026-09-28T11:18:59Z",
              reason: "ended",
              recoverable: true,
              recoveryAttempts: 0,
            },
          },
          Duration.millis(50),
        );
        expect(read.status).not.toBe("stopped");
        expect(read.summary ?? "").not.toContain("saved at");
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#13 a stop whose final flush answer was lost terminates on the store's seal, and the stop tells Core the completion it sealed",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions = yield* watchedList<WorkspaceStopOptions | undefined>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const built = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                crypto.randomUUID(),
                "final",
              );
              records.set(`${session.worktreeId}:${epoch}`, {
                worktreeId: session.worktreeId,
                epoch,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(),
              });
              yield* engine.stop(session.id);
              yield* stopOptions.untilChanged(() => stopOptions.items.length > 0, "the stop");
              // Core names the executor by its runtime identity, recorded at launch.
              expect(stopOptions.items[0]?.completion).toEqual({
                captureN: built.manifest.n,
                epoch,
                executorId: "container-7f3a",
                launchId: world.executorLaunches.get(session.id)?.launchId,
                sealedAt: records.get(`${session.worktreeId}:${epoch}`)?.sealedAt.toISOString(),
              });
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopOptions: stopOptions.items,
                resourceId: () => "container-7f3a",
                // The answer never says `complete` (the relay closed, SDK 0.37.2).
                finalCompletion: "unreported",
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#13 a seal with no runtime identity to name sends no completion: Core keeps what it cannot bind",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const records = new Map<string, CaptureCompletionSeal>();
        const stopOptions = yield* watchedList<WorkspaceStopOptions | undefined>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const built = yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                epoch,
                crypto.randomUUID(),
                "final",
              );
              records.set(`${session.worktreeId}:${epoch}`, {
                worktreeId: session.worktreeId,
                epoch,
                executorId: world.executorLaunches.get(session.id)?.launchId ?? "",
                captureId: built.id,
                n: built.manifest.n,
                sealedAt: new Date(),
              });
              yield* engine.stop(session.id);
              yield* stopOptions.untilChanged(() => stopOptions.items.length > 0, "the stop");
              expect(stopOptions.items[0]?.completion).toBeUndefined();
            }),
          {
            captured: memory,
            seals: memorySeals(records),
            // SDK 0.37.2: no `details()`, so no runtime identity.
            sealantLayer: lifecycleLayer(created, {
              captureOps: { stopOptions: stopOptions.items, finalCompletion: "unreported" },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "a stop the platform answers by keeping the executor for recovery is not an end: `not saved · executor kept for recovery`, the lease stays",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* observed.untilChanged(
                () => world.sessions.get(session.id)?.captureNotSavedAt != null,
                "the kept drain",
              );
              const kept = world.sessions.get(session.id);
              expect(kept === undefined ? null : captureStatusLine(kept)).toBe(
                "not saved · executor kept for recovery · exited before its final flush completed · 0 pending",
              );
              expect(kept?.settledAt).toBeNull();
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: () => "kept",
                retained: () => ({
                  reason: "exited before its final flush completed",
                  recoverable: true,
                }),
              },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#13 without a seal, a stop never attests a completion Core did not observe",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const stopOptions = yield* watchedList<WorkspaceStopOptions | undefined>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              yield* stopOptions.untilChanged(() => stopOptions.items.length > 0, "the stop");
              expect(stopOptions.items[0]?.completion).toBeUndefined();
            }),
          {
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              captureOps: { stopOptions: stopOptions.items },
            }),
          },
        );
      }),
    { timeout: 20_000 },
  );

  it.effect(
    "#14 a landing is refused while the executor's small snapshot carries an unreadable path, however empty its queue, and taken once it reads again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(123_000);
        const clock = yield* Clock.Clock;
        const retries = yield* landingRetries;
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        let readable = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
              const refused = yield* retries.run(
                engine.landingCheckpoint(session.id, "user-mark").pipe(Effect.flip),
              );
              expect(refused._tag).toBe("CapturesBehindError");
              expect(world.sessions.get(session.id)?.captureFailingError).toContain("unreadable");
              readable = true;
              expect(yield* engine.flushCaptures(session.id, "landing")).toBe("flushed");
              const taken = yield* engine.landingCheckpoint(session.id, "user-mark");
              expect(taken.captureId).toBe(memory.chains.get(session.worktreeId)?.headCapture);
            }),
          {
            captured: memory,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                finalCompletion: "unreported",
                flush: () =>
                  Effect.andThen(
                    retries.record,
                    Effect.succeed(
                      readable
                        ? flushReport(0, 1)
                        : {
                            ...flushReport(0, 1),
                            lastSnapError: "unreadable current source file",
                            snapFailingSinceUnixMs: clock.currentTimeMillisUnsafe(),
                            unreadable: 1,
                            carried: 1,
                            unreadablePaths: ["tree/app.ts"],
                          },
                    ),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it(
    "review 3 #17 a suspend flush whose small snapshot carried an unreadable path logs partial · unreadable, never completed",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const logs: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            logs.length = 0;
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
            const flushed = logs.filter((line) => line.includes("capture flush ·"));
            expect(flushed).toEqual([
              "session engine: capture flush · partial · unreadable · observed",
            ]);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  lastSnapError: "unreadable current source file",
                  snapFailingSinceUnixMs: Date.now(),
                  unreadable: 1,
                  carried: 1,
                  unreadablePaths: ["tree/app.ts"],
                }),
            },
          }),
        },
      );
    },
  );

  it.effect(
    "review 3 #16 a flush answer that does not report snapshot health (SDK 0.37.2's facade) holds a landing: partial · snapshot health not reported",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(123_000);
        const retries = yield* landingRetries;
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const logs: Array<string> = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              logs.length = 0;
              expect(yield* engine.flushCaptures(session.id, "landing")).toBe("incomplete");
              expect(logs.filter((line) => line.includes("capture flush ·"))).toEqual([
                "session engine: capture flush · partial · snapshot health not reported · observed",
              ]);
              const refused = yield* retries.run(
                engine.landingCheckpoint(session.id, "user-mark").pipe(Effect.flip),
              );
              expect(refused._tag).toBe("CapturesBehindError");
            }),
          {
            captured: memory,
            logs,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                finalCompletion: "unreported",
                // Exactly the fields `@sealant/sdk` 0.37.2's `capture.flush()` rebuilt, plus the
                // `refused` 0.38.0 requires: no snapshot health, as an older facade or control plane
                // still answers.
                flush: () =>
                  Effect.andThen(
                    retries.record,
                    Effect.succeed({
                      epoch: 2,
                      worktreeId: "",
                      pending: 0,
                      stagedBytes: 0,
                      uploadedObjects: 1,
                      uploadedBytes: 1000,
                      registered: 1,
                      fenced: false,
                      paused: false,
                      refused: [],
                    }),
                  ),
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it(
    "#14 a failing bulk snap does not hold up a landing that needs only the small class",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            expect(yield* engine.flushCaptures(session.id, "landing")).toBe("flushed");
          }),
        {
          captured: memory,
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              finalCompletion: "unreported",
              flush: () =>
                Effect.succeed({
                  ...flushReport(0, 1),
                  lastSnapError: "EACCES: node_modules/.cache",
                  snapFailingSinceUnixMs: Date.now(),
                  snaps: [
                    { class: "small", snapsFailed: 0 },
                    {
                      class: "bulk",
                      snapsFailed: 2,
                      lastSnapError: "EACCES: node_modules/.cache",
                      snapFailingSinceUnixMs: Date.now(),
                    },
                  ],
                }),
            },
          }),
        },
      );
    },
  );
  it.effect(
    "#7 a custom setup that fails after the create leaves the executor on the row: it holds removal, keeps its lease and drains; Core keeping it keeps everything",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const events: string[] = [];
        const stops = yield* watchedList<"drain" | "discard">();
        const kinds: CaptureFlushKind[] = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              expect(failed._tag).toBe("SessionLaunchSetupError");
              expect(created).toHaveLength(1);
              // Addressable from the moment the platform accepted it, before the setup ran.
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              // Drained (a final flush), never stopped outright; Core keeps it.
              yield* stops.untilChanged(() => stops.items.length > 0, "the drain's stop");
              expect(kinds).toContain("final");
              expect(stops.items).toEqual(["drain"]);
              const holds = yield* engine.captureHolds(session.worktreeId);
              expect(holds.map((hold) => hold.sessionId)).toContain(session.id);
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              expect(world.sessions.has(session.id)).toBe(true);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            drainPolicy: { terminationWait: Duration.millis(300) },
            workspaceImage: {
              ...CUSTOM_BASE,
              setupCommands: ["printf work > /workspace/repo/valuable.txt; exit 1"],
            },
            sealantLayer: lifecycleLayer(created, {
              events,
              captureOps: {
                stops: stops.items,
                flushKinds: kinds,
                stopAnswer: () => "kept",
                status: () => "ready",
                exec: (argv) =>
                  argv.includes("printf work > /workspace/repo/valuable.txt; exit 1")
                    ? { exitCode: 1, stdout: "", stderr: "setup failed after writing" }
                    : undefined,
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#7 once that executor saved and ended, the session settles failed with the setup's own words — never an earlier run's outcome",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const stops: Array<"drain" | "discard"> = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              yield* observed.untilChanged(
                () =>
                  stops.length > 0 &&
                  world.sessions.get(session.id)?.settledAt != null &&
                  world.sessions.get(session.id)?.captureDrain === null,
                "the drained session's settle",
              );
              const settled = world.sessions.get(session.id);
              expect(stops).toEqual(["drain"]);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toMatch(/^launch failed: setup command failed \(exit 1\)/);
              // It was saved after all, and says so beside the launch's own words (e2e run 6 #7).
              expect(settled?.summary).toMatch(/ · saved at \d\d:\d\d:\d\d UTC( · capture \d+)?$/);
              // Its end observed: the lease is released.
              expect(memory.leases.get(session.worktreeId)?.executorId).toBeNull();
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            workspaceImage: { ...CUSTOM_BASE, setupCommands: ["exit 1"] },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stops,
                stopAnswer: () => "stopped",
                exec: (argv) =>
                  argv.includes("exit 1") ? { exitCode: 1, stdout: "", stderr: "" } : undefined,
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#7 a harness PTY the platform refuses after the create leaves the executor on the row, draining",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const stops = yield* watchedList<"drain" | "discard">();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              const failed = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              expect(failed._tag).toBe("SealantPlatformError");
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              yield* stops.untilChanged(() => stops.items.length > 0, "the drain's stop");
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            drainPolicy: { terminationWait: Duration.millis(300) },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stops: stops.items,
                stopAnswer: () => "kept",
                status: () => "ready",
                openFails: () => true,
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#7 a lease that names a session with no workspace on its row is unresolved ownership: it holds removal and the worktree, lapsed or not",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              // The launch claimed the worktree; the platform's create answer never reached the row.
              yield* Effect.gen(function* () {
                const repo = yield* CaptureStoreRepo;
                yield* repo.init(session.worktreeId);
                yield* repo.claim(session.worktreeId, session.id, 30);
              }).pipe(Effect.provide(memory.layer));
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBeNull();
              const holds = yield* engine.captureHolds(session.worktreeId);
              expect(holds).toEqual([{ sessionId: session.id, kind: "lease" }]);
              expect(yield* engine.removeWhenStopped(session.id)).toBe("pending");
              expect(world.sessions.has(session.id)).toBe(true);
              // Lapsed: still nobody's end.
              const lease = memory.leases.get(session.worktreeId);
              if (lease !== undefined) lease.expiresAt = memory.clock.now() - 1000;
              expect(yield* engine.captureHolds(session.worktreeId)).toEqual([
                { sessionId: session.id, kind: "lease" },
              ]);
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              // The launch looks at the lease every `leaseWaitInterval` (10 ms) and is refused
              // only once `leaseWait` (300 ms) has run out. Its deadline is fixed just before its
              // first look, which writes the session's waiting line: the clock moves only from
              // there (adjusted earlier, while the launch is still in its native preparation, the
              // looks would count for nothing and the wait would park on a clock nobody moves).
              const launching = yield* Effect.forkChild(
                engine.launch(second.id, ["claude"]).pipe(Effect.flip),
              );
              yield* observed.untilChanged(
                () => (world.sessions.get(second.id)?.summary ?? "").includes("waiting"),
                "the launch's waiting line",
              );
              const began = clock.currentTimeMillisUnsafe();
              for (let look = 0; look < 40 && launching.pollUnsafe() === undefined; look += 1) {
                yield* TestClock.adjust(Duration.millis(10));
              }
              expect(clock.currentTimeMillisUnsafe() - began).toBeGreaterThanOrEqual(300);
              const refused = yield* Fiber.join(launching);
              expect(refused._tag).toBe("SealantPlatformError");
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              yield* engine.reapCaptureLeases();
              yield* TestClock.adjust(Duration.millis(100));
              expect(world.sessions.has(session.id)).toBe(true);
            }),
          { fixture: observed.fixture, captured: memory, sealantLayer: lifecycleLayer([]) },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#16 a restart serves the channel of every session a lease names: a stopped owner whose joined session still works keeps shipping",
    () =>
      Effect.gen(function* () {
        const observed = yield* observedWorld;
        const memory = makeMemoryCaptureStore();
        let ownerId: SessionId | null = null;
        let joinedId: SessionId | null = null;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              ownerId = session.id;
              yield* engine.launch(session.id, ["codex"]);
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              joinedId = second.id;
              yield* engine.launch(second.id, ["claude"]);
              yield* engine.stop(session.id);
              // The owner settles, and its drain, finding the worktree in use, ends.
              yield* observed.untilChanged(() => {
                const owner = world.sessions.get(session.id);
                return owner?.settledAt != null && owner.captureDrain === null;
              }, "owner settles");
              expect(world.sessions.get(session.id)?.captureDrain).toBeNull();
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
              expect(world.sessions.get(second.id)?.status).toBe("running");
            }),
          { fixture: observed.fixture, captured: memory, sealantLayer: lifecycleLayer([]) },
        );
        servedSocketApis.clear();
        yield* withEngineEffect(
          () =>
            Effect.gen(function* () {
              yield* SessionEngine;
              expect([...servedSocketApis.keys()]).toContain(joinedId);
              expect([...servedSocketApis.keys()]).toContain(ownerId);
            }),
          { fixture: observed.fixture, captured: memory, sealantLayer: lifecycleLayer([]) },
        );
      }),
    { timeout: 30_000 },
  );
  it.effect(
    "#9 a recovered opening prompt whose correlated process ended before it took the turn launches again and is delivered; the plan clears only then",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
        const submitted = yield* watchedList<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
              if (process === undefined) throw new Error("missing process");
              // The crash point: the relaunched process row carries the correlation, its opening
              // turn was never submitted, and the process has since ended.
              world.processes.set(
                process.id,
                new SessionProcess({
                  ...process,
                  kind: "agent-protocol",
                  launchCorrelationId: "review2-opening-prompt",
                  exitedAt: new Date(),
                }),
              );
              world.relaunches.set(
                session.id,
                JSON.stringify({
                  kind: "launch",
                  argv: ["codex"],
                  launchCorrelationId: "review2-opening-prompt",
                  start: { mode: "protocol", prompt: "preserve this opening instruction" },
                  author: "user-fixture",
                  resumeId: null,
                }),
              );
              yield* engine.reapCaptureLeases();
              yield* submitted.untilChanged(() => submitted.items.length > 0, "the opening turn");
              yield* observed.untilChanged(
                () => !world.relaunches.has(session.id),
                "the plan's clear",
              );
              expect(submitted.items).toEqual(["preserve this opening instruction"]);
              expect(created).toHaveLength(2);
              const live = [...world.processes.values()].filter(
                (p) => p.sessionId === session.id && p.exitedAt === null,
              );
              expect(live).toHaveLength(1);
              expect(live[0]?.launchCorrelationId).toMatch(/^relaunch:/);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            protocolHostLayer: recordingProtocolHostLayer(attached, submitted.items),
            sealantLayer: lifecycleLayer(created),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#9 an opening prompt its correlated process cannot take now stays planned and the session says so",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
              if (process === undefined) throw new Error("missing process");
              // Live, but nothing here hosts it (not reattached yet): nobody can take the turn.
              world.processes.set(
                process.id,
                new SessionProcess({
                  ...process,
                  kind: "agent-protocol",
                  launchCorrelationId: "review2-unhosted",
                }),
              );
              world.relaunches.set(
                session.id,
                JSON.stringify({
                  kind: "launch",
                  argv: ["codex"],
                  launchCorrelationId: "review2-unhosted",
                  start: { mode: "protocol", prompt: "keep me" },
                  author: "user-fixture",
                  resumeId: null,
                }),
              );
              yield* engine.reapCaptureLeases();
              yield* observed.untilChanged(
                () =>
                  world.sessions
                    .get(session.id)
                    ?.summary?.startsWith("opening prompt not delivered") === true,
                "the retained plan's words",
              );
              yield* TestClock.adjust(Duration.millis(100));
              expect(world.relaunches.has(session.id)).toBe(true);
              expect(created).toHaveLength(1);
            }),
          { captured: memory, fixture: observed.fixture, sealantLayer: lifecycleLayer(created) },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#9 a planned launch the platform refuses in its own words keeps them off the session line (SLNT-385)",
    () =>
      Effect.gen(function* () {
        const words = "Anna is interviewing at Northwind on Friday, keep it quiet";
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        let refusing = false;
        const refused = () =>
          Effect.fail(toPlatformError(new SealantApiError(words, { status: 500 })));
        const refusingLayer = Layer.effect(
          SealantClient,
          Effect.map(SealantClient, (inner) => ({
            ...inner,
            createWorkspace: (...args: Parameters<typeof inner.createWorkspace>) =>
              refusing ? refused() : inner.createWorkspace(...args),
          })),
        ).pipe(Layer.provide(lifecycleLayer(created)));
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
              if (process === undefined) throw new Error("missing process");
              world.processes.set(
                process.id,
                new SessionProcess({
                  ...process,
                  kind: "agent-protocol",
                  launchCorrelationId: "slnt-385-refused",
                  exitedAt: new Date(),
                }),
              );
              world.relaunches.set(
                session.id,
                JSON.stringify({
                  kind: "launch",
                  argv: ["codex"],
                  launchCorrelationId: "slnt-385-refused",
                  start: { mode: "protocol", prompt: "keep me" },
                  author: "user-fixture",
                  resumeId: null,
                }),
              );
              refusing = true;
              yield* engine.reapCaptureLeases();
              yield* observed.untilChanged(
                () =>
                  world.sessions
                    .get(session.id)
                    ?.summary?.startsWith("opening prompt not delivered · the launch failed") ===
                  true,
                "the retained plan's words",
              );
              const summary = world.sessions.get(session.id)?.summary ?? "";
              expect(summary).not.toContain(words);
              expect(summary).toMatch(/ · reference [0-9a-f]{16}$/);
            }),
          { captured: memory, fixture: observed.fixture, sealantLayer: refusingLayer },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "#9 a live, hosted protocol agent takes the opening turn when the correlated row has ended",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const observed = yield* observedWorld;
        const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
        const submitted: string[] = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const process = [...world.processes.values()].find((p) => p.sessionId === session.id);
              if (process === undefined) throw new Error("missing process");
              world.processes.set(
                process.id,
                new SessionProcess({
                  ...process,
                  kind: "agent-protocol",
                  launchCorrelationId: "review2-stale",
                  exitedAt: new Date(),
                }),
              );
              const replacement = SessionProcessId.make(crypto.randomUUID());
              world.processes.set(
                replacement,
                new SessionProcess({
                  ...process,
                  id: replacement,
                  kind: "agent-protocol",
                  launchCorrelationId: null,
                }),
              );
              world.relaunches.set(
                session.id,
                JSON.stringify({
                  kind: "launch",
                  argv: ["codex"],
                  launchCorrelationId: "review2-stale",
                  start: { mode: "protocol", prompt: "to the live one" },
                  author: "user-fixture",
                  resumeId: null,
                }),
              );
              yield* engine.reapCaptureLeases();
              yield* observed.untilChanged(
                () => !world.relaunches.has(session.id),
                "the plan's clear",
              );
              expect(submitted).toEqual(["to the live one"]);
              expect(created).toHaveLength(1);
            }),
          {
            captured: memory,
            fixture: observed.fixture,
            protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
            sealantLayer: lifecycleLayer(created),
          },
        );
      }),
    { timeout: 30_000 },
  );
  it.effect(
    "a planned drain counts back from the platform's own deadline once the SDK reports it (review 2026-09-28, `platformDeadline: null`)",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const created = yield* watchedList<CreateOptions>();
        const logs = yield* watchedList<string>();
        const memory = makeMemoryCaptureStore();
        let asked = 0;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              yield* shipHarnessCapture(
                tmp,
                memory,
                session.worktreeId,
                memory.leases.get(session.worktreeId)?.epoch ?? 0,
                crypto.randomUUID(),
              );
              yield* engine.reapCaptureLeases();
              // The deadline is read in the background and kept once known.
              yield* logs.untilChanged(
                () => logs.items.some((line) => line.includes("the platform's deadline")),
                "the deadline read",
              );
              expect(asked).toBeGreaterThan(0);
              // The cap is 60 s away, inside the 600 s lead: the replacement is due now.
              yield* engine.reapCaptureLeases();
              yield* created.untilChanged(
                () => created.items.length === 2,
                "the replacement launch",
              );
            }),
          {
            captured: memory,
            logs: logs.items,
            sealantLayer: lifecycleLayer(created.items, {
              captureOps: {
                runtimeDeadline: () => {
                  asked += 1;
                  return new Date(clock.currentTimeMillisUnsafe() + 60_000);
                },
              },
            }),
          },
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "an agent whose executor never answered any look does not report the harness's `completed`: its fate is unknown (review 2026-09-28)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const ptyStates = new Map<string, InteractiveSessionStatus>();
        const memory = makeMemoryCaptureStore();
        const rows = yield* observedWorld;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const agent = [...world.processes.values()].find(
                (process) => process.sessionId === session.id && process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              // The harness exits 0; the platform still says `ready`, and no exec is answered.
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The watcher's next look at the PTY (every 2 s) finds the harness gone. Six looks
              // at the executor, 10 ms apart, go unanswered before its fate is read as unknown.
              yield* TestClock.adjust(Duration.seconds(2));
              yield* TestClock.adjust(49);
              expect(world.sessions.get(session.id)?.settledAt ?? null).toBeNull();
              yield* TestClock.adjust(1);
              yield* rows.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session's settle",
              );
              yield* TestClock.adjust(Duration.millis(100));
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("failed");
              expect(settled?.summary).toMatch(
                /^executor not answering · (nothing saved · completion unknown|last capture \d+ at \d\d:\d\d:\d\d UTC · not confirmed)$/,
              );
            }),
          {
            captured: memory,
            fixture: rows.fixture,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              ptyStates,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                // The executor answers nothing at all: no exec, no flush.
                flush: () =>
                  Effect.fail(
                    new SealantPlatformError({
                      code: "connection_closed",
                      status: null,
                      message: "the executor did not answer",
                      cause: null,
                    }),
                  ),
              },
            ),
          },
        );
      }),
    { timeout: 30_000 },
  );
});
