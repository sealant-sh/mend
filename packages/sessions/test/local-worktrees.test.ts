import * as fs from "node:fs";
import * as path from "node:path";

import { ProjectLocalWorktreesRepo, WorktreesRepo } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectLocalWorktrees, ProjectLocalWorktreesLive } from "../src/local-worktrees.ts";
import { projectsLayer, setup, withPreparedEngineEffect } from "./engine/fixture.ts";

describe("the project's shared Local worktree", () => {
  it("creates only on explicit start, keeps the actual default branch, and survives a rename and new service instance", async () => {
    await Effect.runPromise(
      withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) => {
          let allocated: WorktreeId | null = null;
          const allocations = Layer.succeed(ProjectLocalWorktreesRepo, {
            find: () => Effect.succeed(allocated),
            reserve: () => Effect.sync(() => (allocated ??= WorktreeId.make(crypto.randomUUID()))),
          });
          const service = ProjectLocalWorktreesLive.pipe(
            Layer.provide(allocations),
            Layer.provide(projectsLayer(world)),
          );
          return Effect.gen(function* () {
            const local = yield* ProjectLocalWorktrees;
            expect(yield* local.find(project.id)).toBeNull();
            expect(allocated).toBeNull();
            expect(world.worktrees.size).toBe(0);
            const started = yield* local.start(project.id, "person-one");
            expect(started.branch).toBe(project.defaultBranch);
            expect(started.baseRef).toBe(project.defaultBranch);
            const root = path.join(path.dirname(project.storePath), "worktrees", started.directory);
            fs.writeFileSync(path.join(root, "app.ts"), "local edits\n");
            fs.writeFileSync(path.join(root, "new.txt"), "new local file\n");
            yield* (yield* WorktreesRepo).rename(started.id, "renamed", started.branch);
            const again = yield* local.start(project.id, "person-two");
            expect(again.id).toBe(started.id);
            expect(again.name).toBe("renamed");
            expect(world.worktrees.size).toBe(1);
            expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("local edits\n");
            expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("new local file\n");
            const afterRestart = yield* Effect.flatMap(ProjectLocalWorktrees, (fresh) =>
              fresh.find(project.id),
            ).pipe(Effect.provide(service));
            expect(afterRestart?.id).toBe(started.id);
          }).pipe(Effect.provide(service));
        },
      ),
    );
  });
});
