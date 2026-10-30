import { isRemovalFenced } from "@mend/db";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { launchOnce } from "./engine/capture-fixture.ts";
import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";

/**
 * What a worktree removal counts as still saving (`SessionEngine.captureHolds`, docs/adr/0007
 * "Worktree removal"): every live lease, whoever holds it, stands in the way.
 */
describe("capture holds a removal reads", () => {
  it("counts a live lease Mend itself holds while it saves", { timeout: 20_000 }, async () => {
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          memory.leases.set(session.worktreeId, {
            executorId: `mend:${session.worktreeId}`,
            epoch: 7,
            expiresAt: Date.now() + 60_000,
          });
          expect(yield* engine.captureHolds(session.worktreeId)).toContainEqual({
            sessionId: null,
            kind: "lease",
          });
        }),
      { captured: memory },
    );
  });

  it(
    "counts a live lease whose session row is gone: its executor still heartbeats",
    { timeout: 20_000 },
    async () => {
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            memory.leases.set(session.worktreeId, {
              executorId: "session-deleted",
              epoch: 7,
              expiresAt: Date.now() + 60_000,
            });
            expect(yield* engine.captureHolds(session.worktreeId)).toContainEqual({
              sessionId: null,
              kind: "lease",
            });
          }),
        { captured: memory },
      );
    },
  );

  it("does not count a lapsed lease of Mend's own", { timeout: 20_000 }, async () => {
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          memory.leases.set(session.worktreeId, {
            executorId: `mend:${session.worktreeId}`,
            epoch: 7,
            expiresAt: Date.now() - 60_000,
          });
          expect(yield* engine.captureHolds(session.worktreeId)).not.toContainEqual({
            sessionId: null,
            kind: "lease",
          });
        }),
      { captured: memory },
    );
  });
});

describe("new work in a session a removal has marked", () => {
  it("opens no shell on the platform while a removal checks the session's worktree", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["claude"]);
          const opened = spawned.length;
          world.removalMarkedSessions.add(session.id);
          const refused = yield* engine.openShell(session.id).pipe(Effect.exit);
          expect(Exit.isFailure(refused) && isRemovalFenced(refused.cause)).toBe(true);
          expect(spawned).toHaveLength(opened);
          world.removalMarkedSessions.delete(session.id);
          yield* engine.openShell(session.id);
          expect(spawned).toHaveLength(opened + 1);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
    );
  });
});
