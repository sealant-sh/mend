import { isWakeShell } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { screenRows, withScreens } from "./engine/screen-fixture.ts";

describe("wake a stopped screen without an agent turn (ADR 0020)", () => {
  it.effect(
    "reopens a stopped workspace as a shell, reserves its display and starts only the screen",
    () =>
      withScreens(
        (world, platform) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const [project] = [...world.projects.values()];
            if (project === undefined) throw new Error("no project");
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "wake-screen",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(session.id, ["claude"]);
            const before = yield* engine.startScreen(session.id);
            yield* engine.stopScreen(session.id, "idle");
            yield* engine.stop(session.id);
            // Stop answers before the workspace's saved stop finishes.
            yield* Effect.promise(async () => {
              for (let attempt = 0; attempt < 100; attempt++) {
                const current = world.sessions.get(session.id);
                if (
                  world.finalFlushed.get(session.id) === before.workspaceId &&
                  current?.captureDrain === null &&
                  current.status === "stopped"
                )
                  return;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              throw new Error("the workspace did not stop");
            });
            const runs = [...world.sessionRuns.values()];
            const processes = new Set(world.processes.keys());
            const opened = platform.spawned.length;

            // The fixture defects on every turn admission, protocol attach or send, and payer write.
            yield* engine.wakeScreen(session.id);
            const after = yield* world.screens.ofSession(session.id);
            expect(after?.display).toBe(before.display);
            expect(after?.workspaceId).not.toBe(before.workspaceId);
            expect(after?.life._tag).toBe("Starting");
            expect([...world.sessionRuns.values()]).toEqual(runs);
            const added = [...world.processes.values()].filter((row) => !processes.has(row.id));
            expect(added.map((row) => row.kind).toSorted()).toEqual(["screen", "shell"]);
            expect(added.every((row) => row.runsAs === "user-fixture")).toBe(true);
            expect(added.filter((row) => row.kind === "shell").every(isWakeShell)).toBe(true);
            expect(platform.spawned.slice(opened)).toHaveLength(2);
            expect(world.sessions.get(session.id)?.status).toBe("idle");
            expect(world.sessions.get(session.id)?.settledAt).toBeNull();
            expect(yield* engine.screenPasswords(session.id)).not.toBeNull();

            yield* engine.wakeScreen(session.id);
            expect(platform.spawned.slice(opened)).toHaveLength(2);
            expect(screenRows(world).filter((row) => row.exitedAt === null)).toHaveLength(1);
          }),
        { distinctWorkspaces: true },
      ),
  );

  it.effect("uses the live workspace when only the screen idled out, leaving its agent alone", () =>
    withScreens(
      (world, platform) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const [project] = [...world.projects.values()];
          if (project === undefined) throw new Error("no project");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "wake-screen",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["claude"]);
          const screen = yield* engine.startScreen(session.id);
          yield* engine.stopScreen(session.id, "idle");
          const opened = platform.spawned.length;
          const runs = [...world.sessionRuns.values()];
          yield* engine.wakeScreen(session.id);
          expect(platform.spawned.slice(opened)).toHaveLength(1);
          expect(platform.spawned.at(-1)?.[3]).toBe("mend-screen");
          expect((yield* world.screens.ofSession(session.id))?.workspaceId).toBe(
            screen.workspaceId,
          );
          expect([...world.sessionRuns.values()]).toEqual(runs);
          expect(
            [...world.processes.values()].filter((row) => row.kind === "agent-pty"),
          ).toHaveLength(1);
        }),
      { distinctWorkspaces: true },
    ),
  );
});
