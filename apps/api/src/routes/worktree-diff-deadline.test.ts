import { WorktreeRangeDiff } from "@mend/api-contracts";
import { CheckpointId, SequenceNumber, Sha, WorktreeId } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import type { DiffFileFact } from "@mend/store";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const WORKTREE = ids("private-alice").worktree;
const chain = [0, 1].map(
  (ordinal) =>
    new Checkpoint({
      id: CheckpointId.make(`deadline-${ordinal}`),
      worktreeId: WorktreeId.make(WORKTREE),
      sessionId: null,
      ordinal,
      ref: `refs/mend/checkpoints/${WORKTREE}/${ordinal}`,
      sha: Sha.make((ordinal === 0 ? "a" : "b").repeat(40)),
      sealantRunId: null,
      seq: SequenceNumber.make(BigInt(ordinal)),
      trigger: "turn-boundary",
      createdAt: new Date(0),
    }),
);
const facts: ReadonlyArray<DiffFileFact> = [
  {
    oldPath: null,
    newPath: "first.ts",
    status: "added",
    additions: 1,
    deletions: 0,
    binary: false,
  },
  {
    oldPath: null,
    newPath: "second.ts",
    status: "added",
    additions: 1,
    deletions: 0,
    binary: false,
  },
];
const path = `/api/worktrees/${WORKTREE}/diff?from=deadline-0&to=deadline-1`;

/** The live guard only prevents a broken test from retaining its owned request/resources. */
const guarded = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  TestClock.testClockWith((clock) =>
    clock.withLive(
      program.pipe(Effect.provideService(Clock.Clock, clock), Effect.timeout("5 seconds")),
    ),
  );

describe("the actual range-diff route's shared deadline", () => {
  it(
    "cuts a blocked listing at twenty seconds and interrupts the reader without rendering",
    { timeout: 10_000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const interrupted = yield* Ref.make(false);
          const clock = yield* Clock.clockWith(Effect.succeed);
          const controller = new AbortController();
          let pending: Promise<Response> | undefined;
          let renders = 0;
          const api = yield* Effect.acquireRelease(
            Effect.promise(() =>
              createTenancyApi(
                {},
                {
                  effectClock: clock,
                  requestSignal: controller.signal,
                  implement: {
                    checkpoints: { listForWorktree: () => Effect.succeed(chain) },
                    reads: {
                      diffFileFactsBounded: (_project, _worktree, _from, _to, options) =>
                        Effect.gen(function* () {
                          expect(options).toEqual({
                            maxBytes: 8 * 1024 * 1024,
                            deadlineMs: 10_000,
                            minFiles: 200,
                          });
                          yield* Deferred.succeed(entered, undefined);
                          return yield* Effect.never;
                        }).pipe(Effect.ensuring(Ref.set(interrupted, true))),
                      diffRange: () =>
                        Effect.sync(() => {
                          renders += 1;
                          throw new Error("No patches may be read after listing used the deadline");
                        }),
                    },
                  },
                },
              ),
            ),
            (fixture) =>
              Effect.promise(async () => {
                controller.abort();
                if (pending !== undefined) await Promise.allSettled([pending]);
                await fixture.dispose();
              }),
          );
          const responsePromise = api.request("alice", "GET", path);
          pending = responsePromise;
          const request = yield* Effect.promise(() => responsePromise).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(19_999);
          expect(request.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1);
          const response = yield* Fiber.join(request);
          expect(response.status).toBe(200);
          const answer = Schema.decodeUnknownSync(WorktreeRangeDiff)(
            yield* Effect.promise(() => response.json()),
          );
          expect(answer).toMatchObject({
            worktreeId: WORKTREE,
            files: [],
            diff: "",
            omitted: [],
            listingCut: true,
            truncated: true,
          });
          expect(yield* Ref.get(interrupted)).toBe(true);
          expect(renders).toBe(0);
        }).pipe(Effect.scoped, guarded, Effect.provide(TestClock.layer())),
      );
    },
  );

  it(
    "gives rendering only what remains after listing, then interrupts it with known omitted paths",
    { timeout: 10_000 },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const listingEntered = yield* Deferred.make<void>();
          const listingRelease = yield* Deferred.make<void>();
          const renderEntered = yield* Deferred.make<void>();
          const interrupted = yield* Ref.make(false);
          const clock = yield* Clock.clockWith(Effect.succeed);
          const controller = new AbortController();
          let pending: Promise<Response> | undefined;
          const api = yield* Effect.acquireRelease(
            Effect.promise(() =>
              createTenancyApi(
                {},
                {
                  effectClock: clock,
                  requestSignal: controller.signal,
                  implement: {
                    checkpoints: { listForWorktree: () => Effect.succeed(chain) },
                    reads: {
                      diffFileFactsBounded: (_project, _worktree, _from, _to, options) =>
                        Effect.gen(function* () {
                          expect(options).toEqual({
                            maxBytes: 8 * 1024 * 1024,
                            deadlineMs: 10_000,
                            minFiles: 200,
                          });
                          yield* Deferred.succeed(listingEntered, undefined);
                          yield* Deferred.await(listingRelease);
                          return { value: { facts, cut: false }, stamp: WORKTREE_STAMP };
                        }),
                      diffRange: (_project, _worktree, _from, _to, options) =>
                        Effect.gen(function* () {
                          expect(options).toEqual({
                            paths: ["first.ts", "second.ts"],
                            maxBytes: 8 * 1024 * 1024,
                          });
                          yield* Deferred.succeed(renderEntered, undefined);
                          return yield* Effect.never;
                        }).pipe(Effect.ensuring(Ref.set(interrupted, true))),
                    },
                  },
                },
              ),
            ),
            (fixture) =>
              Effect.promise(async () => {
                controller.abort();
                if (pending !== undefined) await Promise.allSettled([pending]);
                await fixture.dispose();
              }),
          );
          const responsePromise = api.request("alice", "GET", path);
          pending = responsePromise;
          const request = yield* Effect.promise(() => responsePromise).pipe(Effect.forkChild);
          yield* Deferred.await(listingEntered);
          yield* TestClock.adjust(10_000);
          yield* Deferred.succeed(listingRelease, undefined);
          yield* Deferred.await(renderEntered);
          yield* TestClock.adjust(9_999);
          expect(request.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1);
          const response = yield* Fiber.join(request);
          expect(response.status).toBe(200);
          const answer = Schema.decodeUnknownSync(WorktreeRangeDiff)(
            yield* Effect.promise(() => response.json()),
          );
          expect(answer).toMatchObject({
            worktreeId: WORKTREE,
            files: facts,
            diff: "",
            omitted: ["first.ts", "second.ts"],
            listingCut: false,
            truncated: true,
          });
          expect(yield* Ref.get(interrupted)).toBe(true);
        }).pipe(Effect.scoped, guarded, Effect.provide(TestClock.layer())),
      );
    },
  );
});
