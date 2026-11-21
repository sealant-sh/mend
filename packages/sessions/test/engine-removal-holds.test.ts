import { isRemovalFenced } from "@mend/db";
import { Session } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { launchOnce } from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

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
          const running = world.sessions.get(session.id);
          if (running === undefined) return yield* Effect.die("no session row");
          world.sessions.set(session.id, new Session({ ...running, status: "completed" }));
          world.removalMarkedSessions.add(session.id);
          const refused = yield* engine.openShell(session.id).pipe(Effect.exit);
          expect(Exit.isFailure(refused) && isRemovalFenced(refused.cause)).toBe(true);
          expect(spawned).toHaveLength(opened);
          // A live session's shell goes ahead: the removal reads the session itself, and refuses.
          world.sessions.set(session.id, running);
          yield* engine.openShell(session.id);
          expect(spawned).toHaveLength(opened + 1);
          expect([...world.admissions.values()]).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
    );
  });
});

describe("a session that ends while a removal marks it", () => {
  it.effect(
    "still ends its workspace: the checkpoint the mark refuses is not taken, and the rest of the end goes on",
    () =>
      Effect.gen(function* () {
        // Check VM, preview 292, 21 Nov 2026 (SLNT-1243): an automatic install's shell exited
        // while a project removal held its mark. The end's checkpoint was refused, and that
        // refusal ended the rest of the end with it: the workspace was never stopped, so every
        // later removal of the project was refused as `executor not ended`.
        const created: CreateOptions[] = [];
        const clock = yield* makeEngineClock(["processes", "sessions", "checkpoints"]);
        const stopped = clock.watched<string>();
        const { ptyStates } = clock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "shell",
                label: "install · mend",
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["sh", "-lc", "true"]);
              const agent = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                return yield* Effect.die("the launch recorded no agent PTY");
              }
              const checkpointsBefore = world.checkpoints.length;
              world.removalMarkedSessions.add(session.id);
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              yield* clock.nextLook(agent.sealantSessionId, () => true);
              yield* clock.untilChanged(
                () => stopped.length > 0,
                "the end's sweep stops the workspace nothing holds",
              );
              expect(stopped).toEqual(["workspace-1"]);
              expect(world.sessions.get(session.id)?.status).toBe("completed");
              expect(world.checkpoints).toHaveLength(checkpointsBefore);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              stopped,
              undefined,
              undefined,
              undefined,
              ptyStates,
            ),
          },
        );
      }),
  );
});

/** A platform that holds every workspace create until `proceed`, saying when one is `reached`. */
const holdingCreate = () => {
  const reached = Effect.runSync(Deferred.make<void>());
  const proceed = Effect.runSync(Deferred.make<void>());
  const created: Array<CreateOptions> = [];
  const layer = sealantLaunchLayer(
    created,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      beforeCreate: () =>
        Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    },
  );
  return { reached, proceed, created, layer };
};

describe("a launch admitted before the platform runs anything", () => {
  it(
    "holds its admission while the platform creates the workspace, before any process row",
    { timeout: 20_000 },
    async () => {
      const held = holdingCreate();
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
            const launching = yield* engine
              .launch(session.id, ["claude"])
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(held.reached);
            const whileCreating = {
              admitted: [...world.admissions.values()],
              processes: [...world.processes.values()].filter(
                (process) => process.sessionId === session.id,
              ).length,
            };
            yield* Deferred.succeed(held.proceed, undefined);
            yield* Fiber.join(launching);
            expect(whileCreating).toEqual({ admitted: [session.id], processes: 0 });
            expect([...world.admissions.values()]).toEqual([]);
          }),
        { sealantLayer: held.layer },
      );
    },
  );

  it(
    "creates nothing on the platform for a settled session a removal marks",
    { timeout: 20_000 },
    async () => {
      const created: Array<CreateOptions> = [];
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
            const settled = world.sessions.get(session.id);
            if (settled === undefined) return yield* Effect.die("no session row");
            world.sessions.set(
              session.id,
              new Session({ ...settled, status: "failed", settledAt: new Date() }),
            );
            world.removalMarkedSessions.add(session.id);
            const refused = yield* engine.launch(session.id, ["claude"]).pipe(Effect.exit);
            expect(Exit.isFailure(refused) && isRemovalFenced(refused.cause)).toBe(true);
            expect(created).toHaveLength(0);
            expect([...world.admissions.values()]).toEqual([]);
          }),
        { sealantLayer: sealantLaunchLayer(created) },
      );
    },
  );
});
