import { it } from "@effect/vitest";
import { StoreRefsRepo } from "@mend/db";
import { BlobStore, packIdxKeyOf, landedRefOf } from "@mend/store";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";

import { COMMIT_NOT_KEPT } from "../src/git-words.ts";
import { LandingGit } from "../src/landing.ts";
import { withCapturedFixture } from "./captured-fixture.ts";

const failures: ReadonlyArray<"pack" | "index"> = ["pack", "index"];
for (const failure of failures) {
  it.live(
    failure === "pack"
      ? "a landing commit the store could not keep reports a readable commit error"
      : "a failed index write leaves its immutable pack orphaned and publishes no landing pointer",
    () =>
      withCapturedFixture((f) =>
        f.provide(
          Effect.gen(function* () {
            const git = yield* LandingGit;
            const blobs = yield* BlobStore;
            const beforeRows = f.inventory();
            const beforeRefs = f.refs();
            const beforeAgent = f.agentState();
            const beforeKeys = new Set((yield* blobs.list(f.prefix)).map((entry) => entry.key));
            const input = {
              checkpoint: f.first.checkpoint,
              agentHead: f.first.agentHead,
              lastLanded: null,
              author: { name: "Ada", email: "ada@example.invalid" },
              message: "Land the fix",
              keep: true,
            };
            f.failWrites(failure);
            const error = yield* git.commit(f.world, input).pipe(Effect.flip);
            expect(error._tag).toBe("LandingStepError");
            expect(error.step).toBe("commit");
            expect(error.message).toBe(COMMIT_NOT_KEPT);
            expect(error.message).not.toContain("BlobStoreError");
            expect(error.message).not.toContain("bucket");
            expect(f.inventory()).toEqual(beforeRows);
            expect(f.refs()).toEqual(beforeRefs);
            expect(f.agentState()).toEqual(beforeAgent);
            const newObjects = (yield* blobs.list(f.prefix)).filter(
              (entry) => !beforeKeys.has(entry.key),
            );
            expect(newObjects).toHaveLength(failure === "pack" ? 0 : 1);
            for (const object of newObjects) {
              expect(object.key.endsWith(".idx")).toBe(false);
              expect(yield* blobs.head(packIdxKeyOf(object.key))).toBeNull();
            }
            f.failWrites(null);
            const retried = yield* git.commit(f.world, input);
            expect(retried.commitSha).toBe(retried.head);
            expect(f.inventory()).toHaveLength(beforeRows.length + 1);
            const ref = yield* (yield* StoreRefsRepo).get(
              f.world.project.id,
              landedRefOf(f.world.worktree.id),
            );
            expect(ref).toMatchObject({ sha: retried.head, version: 1 });
            f.deleteCache();
            // Source capture packs remain retained; only the disposable runner is rebuilt.
            expect(yield* git.holds(f.world, { sha: retried.head, base: f.base })).toBe(true);
            expect(f.git(f.cachePath, ["rev-parse", `${retried.head}^{tree}`])).toBe(f.first.tree);
            expect(f.agentState()).toEqual(beforeAgent);
          }),
        ),
      ),
  );
}

it.live("a competing landed-ref CAS retains the winner and refuses the losing real commit", () =>
  withCapturedFixture((f) =>
    Effect.gen(function* () {
      const beforeRows = f.inventory();
      const beforeAgent = f.agentState();
      const pause = yield* f.pauseNextRefSet;
      const losing = yield* f
        .provide(
          Effect.gen(function* () {
            return yield* (yield* LandingGit)
              .commit(f.world, {
                checkpoint: f.first.checkpoint,
                agentHead: f.first.agentHead,
                lastLanded: null,
                author: { name: "Ada", email: "ada@example.invalid" },
                message: "Losing landing",
                keep: true,
              })
              .pipe(Effect.flip);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(pause.entered);
      const winner = yield* f.provide(
        Effect.gen(function* () {
          const refs = yield* StoreRefsRepo;
          return yield* refs.set(
            f.world.project.id,
            landedRefOf(f.world.worktree.id),
            f.base,
            null,
          );
        }),
      );
      yield* Deferred.succeed(pause.release, undefined);
      const error = yield* Fiber.join(losing);
      expect(error._tag).toBe("LandingStepError");
      expect(error.step).toBe("commit");
      expect(error.message).toBe(
        `${landedRefOf(f.world.worktree.id)} moved while landing · another landing ran at once`,
      );
      expect(
        yield* f.provide(
          Effect.gen(function* () {
            return yield* (yield* StoreRefsRepo).get(
              f.world.project.id,
              landedRefOf(f.world.worktree.id),
            );
          }),
        ),
      ).toEqual(winner);
      expect(winner).toMatchObject({ sha: f.base, version: 1 });
      const orphaned = f
        .inventory()
        .filter((row) => !beforeRows.some((old) => old.key === row.key));
      expect(orphaned).toHaveLength(1);
      yield* f.provide(
        Effect.gen(function* () {
          const blobs = yield* BlobStore;
          for (const row of orphaned) {
            expect((yield* blobs.get(row.key)).byteLength).toBe(row.bytes);
            expect((yield* blobs.get(packIdxKeyOf(row.key))).byteLength).toBeGreaterThan(0);
          }
        }),
      );
      expect(f.agentState()).toEqual(beforeAgent);
    }),
  ),
);
