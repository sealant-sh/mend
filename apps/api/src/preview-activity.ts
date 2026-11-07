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
      const groups = Map.groupBy(
        yield* targets.idleCandidates(),
        (candidate) => candidate.attemptId,
      );
      for (const aliases of groups.values()) {
        const candidate = aliases.toSorted(
          (a, b) => (b.lastAdmittedAt?.getTime() ?? 0) - (a.lastAdmittedAt?.getTime() ?? 0),
        )[0];
        if (candidate === undefined) continue;
        const id = candidate.previewId;
        const latest = Math.max(
          candidate.startedAt.getTime(),
          candidate.lastAdmittedAt?.getTime() ?? 0,
          ...aliases.map(({ previewId }) => pending.get(previewId)?.getTime() ?? 0),
        );
        if (
          aliases.some(({ previewId }) => active.has(previewId) || stopping.has(previewId)) ||
          clock.currentTimeMillisUnsafe() - latest < idleMs
        )
          continue;
        const done = Deferred.makeUnsafe<void>();
        for (const { previewId } of aliases) stopping.set(previewId, done);
        yield* targets
          .stopIdle(
            id,
            candidate.attemptId,
            idleMs,
            Effect.sync(() => {
              for (const { previewId } of aliases) closePreview(previewId);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const { previewId } of aliases) stopping.delete(previewId);
                Deferred.doneUnsafe(done, Effect.void);
              }),
            ),
          );
      }
    });
    return { enter, admitted, sweep };
  });
