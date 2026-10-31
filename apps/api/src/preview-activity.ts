import type { PreviewId } from "@mend/domain";
import { Clock, Deferred, Effect, type Scope } from "effect";

import { PreviewTargets } from "./preview-targets.ts";

/** Gateway-owned activity: HTTP requests hold a stop; upgraded sockets do not. */
export interface PreviewActivity {
  readonly enter: (id: PreviewId) => Effect.Effect<() => void, never, Scope.Scope>;
  readonly admitted: (id: PreviewId) => void;
  readonly sweep: Effect.Effect<void>;
}

/** Batch admission stamps before sweeping, and serialize visits with each idle stop. */
export const makePreviewActivity = (
  idleMs: number,
  closePreview: (id: PreviewId) => void,
): Effect.Effect<PreviewActivity, never, PreviewTargets> =>
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;
    const clock = yield* Clock.Clock;
    const pending = new Map<PreviewId, Date>();
    const active = new Map<PreviewId, number>();
    const stopping = new Map<PreviewId, Deferred.Deferred<void>>();
    const enter = (id: PreviewId) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const stop = stopping.get(id);
          if (stop !== undefined) yield* Deferred.await(stop).pipe(Effect.interruptible);
          active.set(id, (active.get(id) ?? 0) + 1);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            const count = (active.get(id) ?? 1) - 1;
            if (count === 0) active.delete(id);
            else active.set(id, count);
          };
        }),
        (release) => Effect.sync(release),
      );
    const admitted = (id: PreviewId) => {
      pending.set(id, new Date(clock.currentTimeMillisUnsafe()));
    };
    const sweep = Effect.gen(function* () {
      const batch = new Map(pending);
      yield* targets.touchActivity(batch);
      for (const [id, at] of batch) if (pending.get(id) === at) pending.delete(id);
      for (const candidate of yield* targets.idleCandidates()) {
        const id = candidate.previewId;
        const latest = Math.max(
          candidate.startedAt.getTime(),
          candidate.lastAdmittedAt?.getTime() ?? 0,
          pending.get(id)?.getTime() ?? 0,
        );
        if (active.has(id) || stopping.has(id) || clock.currentTimeMillisUnsafe() - latest < idleMs)
          continue;
        const done = Deferred.makeUnsafe<void>();
        stopping.set(id, done);
        yield* targets
          .stopIdle(
            id,
            candidate.attemptId,
            idleMs,
            Effect.sync(() => closePreview(id)),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopping.delete(id);
                Deferred.doneUnsafe(done, Effect.void);
              }),
            ),
          );
      }
    });
    return { enter, admitted, sweep };
  });
