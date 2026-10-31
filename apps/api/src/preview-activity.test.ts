import { PreviewId, ServiceId, SessionProcessId } from "@mend/domain";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";

import { makePreviewActivity } from "./preview-activity.ts";
import { PreviewTargets } from "./preview-targets.ts";

const id = PreviewId.make("preview-idle");
const attemptId = SessionProcessId.make("attempt-idle");
const serviceId = ServiceId.make("service-idle");

describe("gateway idle clock", () => {
  it.effect("stops at the deadline, persists batches, and holds in-flight HTTP requests", () => {
    let stamp: Date | null = null;
    const stopped: string[] = [];
    const closed: string[] = [];
    let batches = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* makePreviewActivity(1_800_000, (previewId) =>
          closed.push(previewId),
        );
        yield* TestClock.adjust("29 minutes");
        yield* activity.sweep;
        expect(stopped).toEqual([]);
        activity.admitted(id);
        activity.admitted(id);
        expect(batches).toBe(0);
        yield* activity.sweep;
        expect(batches).toBe(1);
        yield* TestClock.adjust("29 minutes");
        yield* activity.sweep;
        expect(stopped).toEqual([]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* activity.enter(id);
            yield* TestClock.adjust("1 minute");
            yield* activity.sweep;
            expect(stopped).toEqual([]);
            expect(closed).toEqual([]);
          }),
        );
        yield* activity.sweep;
        expect(stopped).toEqual([attemptId]);
        expect(closed).toEqual([id]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mock(PreviewTargets, {
          touchActivity: (stamps) =>
            Effect.sync(() => {
              if (stamps.size > 0) batches += 1;
              stamp = stamps.get(id) ?? stamp;
            }),
          idleCandidates: () =>
            Effect.sync(() => [
              {
                previewId: id,
                serviceId,
                attemptId,
                startedAt: new Date(0),
                lastAdmittedAt: stamp,
              },
            ]),
          stopIdle: (_id, attempt, _idleMs, beforeStop) =>
            beforeStop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  stopped.push(attempt);
                  return true;
                }),
              ),
            ),
        }),
      ),
    );
  });
});
