import { isWakeShell, protocolIdleReading, protocolIdleStopDue } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Schedule } from "effect";
import { expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";

it("screen wake restores a stopped workspace without an agent and can idle-stop again", async () => {
  const created: CreateOptions[] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const platform = sealantLaunchLayer(created, undefined, undefined, spawned);
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        yield* engine.wakeWorkspace(session.id, { reason: "screen" });
        yield* engine.stop(session.id);
        yield* Effect.sync(() => world.sessions.get(session.id)?.status).pipe(
          Effect.repeat({
            until: (status) => status === "stopped" || status === "completed",
            schedule: Schedule.spaced("10 millis"),
            times: 200,
          }),
        );
        expect(world.sessions.get(session.id)?.settledAt).not.toBeNull();
        const stopped = world.sessions.get(session.id)?.sealantWorkspaceId;
        if (stopped == null) return yield* Effect.die("missing workspace");
        const workspace = yield* SealantClient.use((client) => client.getWorkspace(stopped)).pipe(
          Effect.provide(platform),
        );
        expect(yield* Effect.promise(() => workspace.status())).toBe("stopped");
        const woken = yield* engine.wakeWorkspace(session.id, { reason: "screen" });
        const rows = [...world.processes.values()].filter((row) => row.sessionId === session.id);
        const live = rows.filter((row) => row.exitedAt === null);
        expect(live).toHaveLength(1);
        expect(live.every(isWakeShell)).toBe(true);
        expect(rows.every((row) => row.kind === "shell")).toBe(true);
        expect(world.sessionRuns.size).toBe(0);
        expect(created).toHaveLength(2);
        expect(spawned).toHaveLength(2);
        const reading = protocolIdleReading({
          session: woken,
          processes: rows,
          turns: [],
          requests: [],
          liveServices: 0,
        });
        expect(reading.kind).toBe("idle");
        if (reading.kind !== "idle") return yield* Effect.die("wake shell held the workspace");
        expect(protocolIdleStopDue(reading, reading.since.getTime() + 15 * 60_000, 15)).toBe(true);
        yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");
        yield* Effect.sync(() => world.sessions.get(session.id)?.status).pipe(
          Effect.repeat({
            until: (status) => status === "stopped" || status === "completed",
            schedule: Schedule.spaced("10 millis"),
            times: 200,
          }),
        );
        expect(world.sessions.get(session.id)?.settledAt).not.toBeNull();
        expect(yield* Effect.promise(() => workspace.status())).toBe("stopped");
        expect([...world.processes.values()].filter((row) => row.exitedAt === null)).toEqual([]);
        expect(world.services.size).toBe(0);
        expect(world.previews.size).toBe(0);
      }),
    {
      captured: makeMemoryCaptureStore(),
      sealantLayer: platform,
    },
  );
});

it("refuses a concurrent screen wake with session_starting", async () => {
  const opening = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const layer = Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      createWorkspace: (options, launch) =>
        Deferred.succeed(opening, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(client.createWorkspace(options, launch)),
        ),
    })),
  ).pipe(Layer.provide(sealantLaunchLayer([])));
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        const first = yield* Effect.forkChild(
          engine.wakeWorkspace(session.id, { reason: "screen" }),
        );
        yield* Deferred.await(opening);
        const refused = yield* Effect.flip(engine.wakeWorkspace(session.id, { reason: "screen" }));
        expect(refused).toMatchObject({ code: "session_starting" });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      }),
    { captured: makeMemoryCaptureStore(), sealantLayer: layer },
  );
});
