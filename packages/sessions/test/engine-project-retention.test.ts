import { SessionsRepo } from "@mend/db";
import { SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { projectFor } from "./capture-world.ts";
import { sessionsLayer, withPreparedEngineEffect } from "./engine/fixture.ts";

describe("boot with a removed project", () => {
  it("leaves retained session records alone and logs no recovery errors", async () => {
    const logs: Array<{ readonly level: string; readonly message: string }> = [];
    await Effect.runPromise(
      withPreparedEngineEffect(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = projectFor(`${tmp}/retained/repo.git`, "abc");
            world.projects.set(project.id, project);
            world.removedProjects.add(project.id);
            const session = yield* Effect.gen(function* () {
              return yield* (yield* SessionsRepo).create({
                id: SessionId.make("retained-session"),
                projectId: project.id,
                worktreeId: WorktreeId.make("retained-tree"),
                harness: "claude",
                label: null,
                worktree: "retained-tree",
                branch: "work",
                baseSha: Sha.make("abc"),
                baseRef: "main",
                contextSnapshotId: null,
                ownerUserId: "anna",
                origin: "mend",
              });
            }).pipe(Effect.provide(sessionsLayer(world)));
            return session;
          }),
        (world, _tmp, before) =>
          Effect.gen(function* () {
            yield* Effect.sleep("100 millis");
            expect(world.sessions.get(before.id)).toEqual(before);
            expect(logs.filter(({ level }) => ["Warn", "Error", "Fatal"].includes(level))).toEqual(
              [],
            );
          }),
        { leveledLogs: logs },
      ),
    );
  });
});
