import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { headFlush, provisionIn } from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  sealantLaunchLayer,
  setup,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";

/**
 * Stop session (docs/adr/0026, decision 7): the session's agent stops; when no other session in
 * its workspace is running, the workspace and its Services stop too; when another is running,
 * only the session stops.
 */

const ownerStop = { kind: "person", userId: "user-fixture" } as const;

const makeStopClock = makeEngineClock(["processes", "sessions"]);

const serviceLive = (world: World, serviceId: string) => {
  const service = world.services.get(serviceId);
  return (
    service !== undefined &&
    (service.currentAttemptId !== null || service.currentForwardId !== null)
  );
};

describe("SessionEngine stopSession", () => {
  it.effect(
    "the last running session's Stop also stops the workspace's Services, its shells and the workspace",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeStopClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const web = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
              const db = yield* engine.addService(session.id, 5432, "db");
              // A shell beside the agent: a plain stop keeps it, and it would hold the workspace.
              const shell = yield* engine.openShell(session.id);

              const before = yield* engine.stopSessionReach(session.id);
              expect(before.workspace).toBe("stops");
              expect(before.runningSessions).toEqual([]);
              expect(before.services.map((service) => service.name).toSorted()).toEqual([
                "db",
                "web",
              ]);

              const answered = yield* engine.stopSession(session.id, ownerStop);
              expect(answered.workspace).toBe("stops");
              yield* clock.untilChanged(
                () => stopped.includes("workspace-1"),
                "the workspace stops once nothing holds it",
              );
              expect(serviceLive(world, web.service.id)).toBe(false);
              expect(serviceLive(world, db.service.id)).toBe(false);
              expect(world.processes.get(shell.id)?.exitedAt).not.toBeNull();
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.status === "stopped",
                "the session settles stopped",
              );
              // Nothing of the workspace is left to stop.
              expect((yield* engine.stopSessionReach(session.id)).workspace).toBe("none");
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created, undefined, stopped),
          },
        );
      }),
  );

  it.effect(
    "a Stop while another session runs in the workspace stops only the session; the last one's Stop stops the workspace",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeStopClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const first = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(first.id, ["codex"]);
              const db = yield* engine.addService(first.id, 5432, "db");
              const second = yield* engine.provisionSessionIn(first.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              yield* engine.launch(second.id, ["claude"]);
              // One executor per worktree: Maria's session joined the holder's workspace.
              expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-1");

              const firstReach = yield* engine.stopSessionReach(first.id);
              expect(firstReach.workspace).toBe("keeps-running");
              expect(firstReach.runningSessions).toEqual([second.id]);
              expect(firstReach.services.map((service) => service.name)).toEqual(["db"]);

              // The holder stops while Maria's agent runs: her session, the Service and the
              // workspace stay.
              const kept = yield* engine.stopSession(first.id, ownerStop);
              expect(kept.workspace).toBe("keeps-running");
              expect(kept.runningSessions).toEqual([second.id]);
              const agentOf = (sessionId: string) =>
                [...world.processes.values()].find(
                  (process) => process.sessionId === sessionId && process.kind === "agent-pty",
                );
              expect(agentOf(first.id)?.exitedAt).not.toBeNull();
              expect(agentOf(second.id)?.exitedAt).toBeNull();
              expect(serviceLive(world, db.service.id)).toBe(true);
              expect(stopped).toEqual([]);

              // Maria's session is now the last one running: her Stop takes the holder's Service
              // and the workspace with it, saved first.
              const secondReach = yield* engine.stopSessionReach(second.id);
              expect(secondReach.workspace).toBe("stops");
              const ended = yield* engine.stopSession(second.id, {
                kind: "person",
                userId: "user-maria",
              });
              expect(ended.workspace).toBe("stops");
              expect(serviceLive(world, db.service.id)).toBe(false);
              yield* clock.untilChanged(
                () => stopped.includes("workspace-1"),
                "the workspace stops once saved",
              );
              expect(agentOf(second.id)?.exitedAt).not.toBeNull();
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              stopped,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { flush: headFlush(memory) },
            ),
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    20_000,
  );

  it.effect(
    "two Stops at once in one workspace cannot both leave it running",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const memory = makeMemoryCaptureStore();
        const clock = yield* makeStopClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const first = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(first.id, ["codex"]);
              const db = yield* engine.addService(first.id, 5432, "db");
              const second = yield* engine.provisionSessionIn(first.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              yield* engine.launch(second.id, ["claude"]);

              // Each reads the other as running before either stops.
              expect((yield* engine.stopSessionReach(first.id)).workspace).toBe("keeps-running");
              expect((yield* engine.stopSessionReach(second.id)).workspace).toBe("keeps-running");
              const answers = yield* Effect.all(
                [
                  engine.stopSession(first.id, ownerStop),
                  engine.stopSession(second.id, { kind: "person", userId: "user-maria" }),
                ],
                { concurrency: "unbounded" },
              );
              // Each looks after its own agent has ended: the later look sees neither running.
              expect(answers.map((answer) => answer.workspace)).toContain("stops");
              expect(serviceLive(world, db.service.id)).toBe(false);
              yield* clock.untilChanged(
                () => stopped.includes("workspace-1"),
                "the workspace stops once saved",
              );
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              stopped,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { flush: headFlush(memory) },
            ),
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    20_000,
  );
});
