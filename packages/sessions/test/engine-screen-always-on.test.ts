import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeHarnessLayoutsMemoryState } from "@mend/db";
import type { SessionId } from "@mend/domain";
import { composeLaunchArgv, type SessionProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeWorld, recordingProtocolHostLayer, type World } from "./engine/fixture.ts";
import { launched, type Platform, screenRows, withScreens } from "./engine/screen-fixture.ts";

/** The engine's own fibers run on the event loop: give them turns until `done` holds. */
const until = (done: () => Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 400; turn++) {
      if (yield* done()) return;
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    throw new Error(`never observed: ${what}`);
  });

/** Gives the engine's own fibers `count` turns of the event loop, whatever they do with them. */
const turns = (count: number) =>
  Effect.promise(async () => {
    for (let turn = 0; turn < count; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

/** The session's screen process, live, and the screen it runs: null while none runs. */
const runningScreen = (world: World, sessionId: SessionId) =>
  Effect.gen(function* () {
    const screen = yield* world.screens.ofSession(sessionId);
    const row: SessionProcess | undefined =
      screen?.processId == null ? undefined : world.processes.get(screen.processId);
    return screen !== null &&
      (screen.life._tag === "Starting" || screen.life._tag === "Live") &&
      row?.exitedAt === null
      ? { screen, row }
      : null;
  });

const screenRuns = (world: World, sessionId: SessionId, what: string) =>
  until(() => Effect.map(runningScreen(world, sessionId), (running) => running !== null), what);

const screenStarts = (platform: Platform) =>
  platform.spawned.filter((argv) => argv[3] === "mend-screen").length;

/** Saved harness state, so a follow-up or a resume has a conversation to carry on. */
const savedState = (world: World, sessionId: SessionId) => {
  const [project] = [...world.projects.values()];
  if (project === undefined) throw new Error("no project");
  const state = sessionStatePathOf(project.storePath, sessionId);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "manifest.json"),
    JSON.stringify({
      harness: "claude",
      providerSessionId: null,
      capturedAt: "2026-11-03",
    }),
  );
  fs.writeFileSync(path.join(state, "harness-state.tar.gz"), "fake-archive");
};

describe("the screen runs with its session (ADR 0020, D7)", () => {
  it.effect(
    "starts beside the agent at a cold launch, a join and a follow-up, with no screen tool call",
    () =>
      withScreens((world, platform) =>
        Effect.gen(function* () {
          const { engine, session: first } = yield* launched(world);
          yield* screenRuns(world, first.id, "the cold launch's screen");

          const second = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: "user-fixture",
          });
          yield* engine.launch(second.id, ["claude"]);
          yield* screenRuns(world, second.id, "the join's screen");
          const joined = yield* runningScreen(world, second.id);
          expect(joined?.screen.display).toBe(11);

          yield* engine.stop(second.id);
          expect(yield* runningScreen(world, second.id)).toBeNull();
          savedState(world, second.id);
          yield* engine.launchFollowUp(second.id, "Carry on.", "follow-up-1", "user-fixture");
          yield* screenRuns(world, second.id, "the follow-up's screen");
          expect(screenStarts(platform)).toBe(3);
        }),
      ),
  );

  it.effect("stops with the session's Stop and starts again when the session resumes", () =>
    withScreens(
      (world, platform) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launched(world);
          yield* screenRuns(world, session.id, "the screen at launch");
          const before = yield* runningScreen(world, session.id);

          yield* engine.stop(session.id);
          const stopped = yield* world.screens.latestForSession(session.id);
          expect(stopped?.life).toEqual({
            _tag: "Ended",
            reason: "session-stopped",
          });
          expect(world.processes.get(before?.row.id ?? "")?.exitedAt).not.toBeNull();

          yield* engine.resumeSession(session.id, "shell");
          yield* screenRuns(world, session.id, "the screen after the resume");
          const after = yield* runningScreen(world, session.id);
          expect(after?.row.id).not.toBe(before?.row.id);
          expect(screenStarts(platform)).toBe(2);
        }),
      { distinctWorkspaces: true },
    ),
  );

  it.effect("keeps running through a mode switch to a conversation", () => {
    const attached: Array<{
      readonly process: SessionProcess;
      readonly mode: string;
    }> = [];
    return withScreens(
      (world) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const [project] = [...world.projects.values()];
          if (project === undefined) throw new Error("no project");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "screen",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, composeLaunchArgv("claude", { mode: "pty" }));
          yield* screenRuns(world, session.id, "the screen at launch");
          yield* engine.switchMode(session.id, "protocol", { mode: "protocol" }, null);
          expect(attached.at(-1)?.process.kind).toBe("agent-protocol");
          yield* screenRuns(world, session.id, "the screen after the switch");
        }),
      { protocolHostLayer: recordingProtocolHostLayer(attached, []) },
    );
  });

  it.effect("lets the agent run when its screen fails to start, and a retry starts it", () => {
    let screenOpen = false;
    let failing = true;
    return withScreens(
      (world) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launched(world);
          yield* until(
            () =>
              Effect.map(
                world.screens.ofSession(session.id),
                (screen) => screen?.life._tag === "Ended",
              ),
            "the failed start recorded",
          );
          const failed = yield* world.screens.ofSession(session.id);
          expect(failed?.life).toEqual({
            _tag: "Ended",
            reason: "start-failed",
          });
          const agents = [...world.processes.values()].filter(
            (row) => row.kind === "agent-pty" && row.exitedAt === null,
          );
          expect(agents).toHaveLength(1);

          failing = false;
          yield* engine.wakeScreen(session.id);
          yield* screenRuns(world, session.id, "the retried screen");
        }),
      {
        aroundOpen: (argv) =>
          Effect.sync(() => {
            screenOpen = argv[3] === "mend-screen";
          }),
        openFails: () => screenOpen && failing,
      },
    );
  });
});

const restartable = (name: string) => ({
  world: makeWorld(),
  tmp: fs.mkdtempSync(path.join(os.tmpdir(), `mend-screen-boot-${name}-`)),
});

describe("the screen after Mend restarts (ADR 0020, D7)", () => {
  it.effect("starts a live session's screen that is not running at boot, with no call", () => {
    const fixture = restartable("start");
    const { world } = fixture;
    const layoutState = makeHarnessLayoutsMemoryState();
    let screenOpen = false;
    return Effect.gen(function* () {
      const sessionId = yield* withScreens(
        () =>
          Effect.gen(function* () {
            const { session } = yield* launched(world);
            yield* until(
              () =>
                Effect.map(
                  world.screens.ofSession(session.id),
                  (screen) => screen?.life._tag === "Ended",
                ),
              "the screen's start failed",
            );
            return session.id;
          }),
        {
          fixture,
          layoutState,
          aroundOpen: (argv) =>
            Effect.sync(() => {
              screenOpen = argv[3] === "mend-screen";
            }),
          openFails: () => screenOpen,
        },
      );
      yield* withScreens(
        (_, platform) =>
          Effect.gen(function* () {
            yield* screenRuns(world, sessionId, "the screen started at boot");
            expect(screenStarts(platform)).toBe(1);
          }),
        {
          fixture,
          layoutState,
          restart: true,
          printed: ["mend-screen ready"],
        },
      );
    });
  });

  it.effect(
    "leaves a screen still running at boot to be signed for again, not started over",
    () => {
      const fixture = restartable("live");
      const { world } = fixture;
      const layoutState = makeHarnessLayoutsMemoryState();
      return Effect.gen(function* () {
        const live = yield* withScreens(
          () =>
            Effect.gen(function* () {
              const { session } = yield* launched(world);
              yield* until(
                () =>
                  Effect.map(
                    world.screens.ofSession(session.id),
                    (screen) => screen?.life._tag === "Live",
                  ),
                "the screen live",
              );
              return yield* runningScreen(world, session.id);
            }),
          { fixture, layoutState, printed: ["mend-screen ready"] },
        );
        if (live === null) throw new Error("no screen running before the restart");
        yield* withScreens(
          (_, platform) =>
            Effect.gen(function* () {
              yield* turns(200);
              expect(screenStarts(platform)).toBe(0);
              expect((yield* runningScreen(world, live.screen.sessionId))?.row.id).toBe(
                live.row.id,
              );
              expect(screenRows(world).filter((row) => row.exitedAt === null)).toHaveLength(1);
            }),
          {
            fixture,
            layoutState,
            restart: true,
            printed: ["mend-screen ready"],
          },
        );
      });
    },
  );
});
