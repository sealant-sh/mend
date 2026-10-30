import * as fs from "node:fs";
import * as path from "node:path";

import { DisplayNumber, type Screen } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Redacted } from "effect";
import { describe, expect } from "vitest";

import { onScreenPath, screenArgv, screenReapArgv } from "../src/screen/script.ts";
import type { World } from "./engine/fixture.ts";
import {
  LAUNCHER,
  lostReap,
  lostStart,
  type Platform,
  screenRows,
  withScreens,
} from "./engine/screen-fixture.ts";

/** The engine's own fibers run on the event loop: give them turns until `done` holds. */
const until = (done: () => Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      if (yield* done()) return;
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    throw new Error(`never observed: ${what}`);
  });

/** Two sessions of one worktree, the second joining the first's executor, then its follow-up. */
const launchJoinAndFollowUp = (world: World) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const [project] = [...world.projects.values()];
    if (project === undefined) throw new Error("no project");
    const first = yield* engine.provision({
      projectId: project.id,
      harness: "claude",
      label: null,
      name: "screen",
      ownerUserId: "user-fixture",
      start: { kind: "base", base: null },
    });
    yield* engine.launch(first.id, ["claude"]);
    const second = yield* engine.provisionSessionIn(first.worktreeId, {
      harness: "claude",
      label: null,
      ownerUserId: "user-fixture",
    });
    yield* engine.launch(second.id, ["claude"]);
    yield* engine.stop(second.id);
    const state = sessionStatePathOf(project.storePath, second.id);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, "manifest.json"),
      JSON.stringify({ harness: "claude", providerSessionId: null, capturedAt: "2026-10-30" }),
    );
    fs.writeFileSync(path.join(state, "harness-state.tar.gz"), "fake-archive");
    yield* engine.launchFollowUp(second.id, "Carry on.", "follow-up-1", "user-fixture");
  });

const agentOpens = (platform: Platform) =>
  platform.spawned.flatMap((argv, at) =>
    argv[3] === "mend-screen" ? [] : [{ argv, options: platform.opened[at] }],
  );

describe("the session's display on every launch (ADR 0020)", () => {
  it.effect(
    "names each session's own display and cookie, the wrapper first on PATH, at a cold launch, a join and a follow-up",
    () =>
      withScreens((world, platform) =>
        Effect.gen(function* () {
          yield* launchJoinAndFollowUp(world);
          const opens = agentOpens(platform);
          expect(opens).toHaveLength(3);
          const uid = opens[0]?.options?.user?.uid;
          for (const { argv } of opens) {
            expect(argv.slice(0, 4)).toEqual(onScreenPath([]));
            expect(argv[2]).toBe('PATH=/run/mend/bin:$PATH exec "$@"');
            expect(argv.length).toBeGreaterThan(4);
          }
          expect(opens.map(({ options }) => options?.env)).toEqual(
            [10, 11, 11].map((display) =>
              expect.objectContaining({
                DISPLAY: `:${display}`,
                XAUTHORITY: `/run/user/${uid}/mend-screen-${display}/auth`,
              }),
            ),
          );
        }),
      ),
  );

  it.effect("names no display in a project whose Environment has no screen", () =>
    withScreens(
      (world, platform) =>
        Effect.gen(function* () {
          yield* launchJoinAndFollowUp(world);
          const opens = agentOpens(platform);
          expect(opens).toHaveLength(3);
          for (const { argv, options } of opens) {
            expect(argv).not.toContain("mend-screen-path");
            expect(options?.env).not.toHaveProperty("DISPLAY");
            expect(options?.env).not.toHaveProperty("XAUTHORITY");
          }
        }),
      { screen: false },
    ),
  );
});

describe("the session's screen (ADR 0020)", () => {
  it.effect(
    "starts as the session's person on its display, records a screen row, and is no Service",
    () =>
      withScreens((world, platform) =>
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
          yield* engine.launch(session.id, ["claude"]);

          const screen = yield* engine.startScreen(session.id);
          expect(screen.display).toBe(10);
          expect(screen.life).toEqual({ _tag: "Starting" });
          const user = platform.opened.at(-1)?.user;
          expect(user?.name).toBe(LAUNCHER);
          expect(platform.spawned.at(-1)).toEqual(
            screenArgv(DisplayNumber.make(10), { uid: user?.uid ?? -1 }),
          );
          expect(platform.spawned.at(-1)?.at(-1)).toBe(`/run/user/${user?.uid}/mend-screen-10`);

          const [row] = screenRows(world);
          expect(row).toMatchObject({
            kind: "screen",
            runsAs: "user-fixture",
            serviceId: null,
            exitedAt: null,
            sealantSessionId: expect.stringMatching(/^pty-/),
          });
          expect(screen.processId).toBe(row?.id);

          const passwords = yield* engine.screenPasswords(session.id);
          if (passwords === null) throw new Error("no passwords held");
          const handedOver = JSON.stringify([platform.spawned.at(-1), platform.opened.at(-1)]);
          for (const password of [passwords.full, passwords.viewOnly]) {
            expect(handedOver).not.toContain(Redacted.value(password));
          }
          expect(platform.listeners).toEqual([]);
          expect(world.sessions.get(session.id)?.status).not.toBe("stopped");

          const again = yield* engine.startScreen(session.id);
          expect(again.id).toBe(screen.id);
          expect(screenRows(world)).toHaveLength(1);
          expect(yield* engine.screenPasswords(session.id)).toBe(passwords);
        }),
      ),
  );

  it.effect("moves to Live on the script's ready line, and to degraded when its client fails", () =>
    withScreens(
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
          yield* engine.launch(session.id, ["claude"]);
          const screen = yield* engine.startScreen(session.id);
          const life = () =>
            Effect.map(
              world.screens.byId(screen.id),
              (now): Screen["life"] | null => now?.life ?? null,
            );
          yield* until(
            () => Effect.map(life(), (now) => now?._tag === "Live" && now.degraded !== null),
            "a degraded screen",
          );
          expect(yield* life()).toEqual({ _tag: "Live", degraded: "client-failed" });
        }),
      { printed: [" vncext: listening", "mend-screen ready", "mend-screen degraded openbox"] },
    ),
  );

  it.effect(
    "gives two sessions in one workspace two displays, and stops each once, with its session's Stop",
    () =>
      withScreens((world) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const [project] = [...world.projects.values()];
          if (project === undefined) throw new Error("no project");
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "screen",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(first.id, ["claude"]);
          const second = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: "user-fixture",
          });
          yield* engine.launch(second.id, ["claude"]);
          const one = yield* engine.startScreen(first.id);
          const two = yield* engine.startScreen(second.id);
          expect(two.workspaceId).toBe(one.workspaceId);
          expect([one.display, two.display]).toEqual([10, 11]);

          yield* engine.stopScreen(second.id, "idle");
          yield* engine.stopScreen(second.id, "idle");
          expect((yield* world.screens.byId(two.id))?.life).toEqual({
            _tag: "Ended",
            reason: "idle",
          });
          expect(world.processes.get(two.processId ?? "")?.exitedAt).not.toBeNull();
          expect(yield* engine.screenPasswords(second.id)).toBeNull();

          yield* engine.stop(first.id);
          expect((yield* world.screens.byId(one.id))?.life).toEqual({
            _tag: "Ended",
            reason: "session-stopped",
          });
          expect(screenRows(world).every((row) => row.exitedAt !== null)).toBe(true);
        }),
      ),
  );

  it.effect("reaps a lost start's display as the person and opens it again, once", () => {
    const lost = lostStart(1);
    return withScreens(
      (world, platform) =>
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
          yield* engine.launch(session.id, ["claude"]);
          lost.arm();
          const screen = yield* engine.startScreen(session.id);
          const reap = screenReapArgv(DisplayNumber.make(10));
          const reaps = platform.execs.flatMap((argv, at) =>
            argv.join("\n") === reap.join("\n") ? [platform.execUsers[at]] : [],
          );
          expect(reaps).toEqual([LAUNCHER]);
          expect(screen.display).toBe(10);
          expect(platform.spawned.filter((argv) => argv[3] === "mend-screen")).toHaveLength(1);
          expect(screenRows(world)).toMatchObject([
            { exitedAt: null, sealantSessionId: expect.any(String) },
          ]);
        }),
      { openFails: lost.openFails },
    );
  });

  it.effect("gives up after one retry, reaps that attempt too, and the screen reads ended", () => {
    const lost = lostStart(2);
    return withScreens(
      (world, platform) =>
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
          yield* engine.launch(session.id, ["claude"]);
          lost.arm();
          const failed = yield* engine.startScreen(session.id).pipe(Effect.flip);
          expect(failed).toMatchObject({ _tag: "SealantPlatformError" });
          const reap = screenReapArgv(DisplayNumber.make(10)).join("\n");
          const reaps = platform.execs.flatMap((argv, at) =>
            argv.join("\n") === reap ? [platform.execUsers[at]] : [],
          );
          expect(reaps).toEqual([LAUNCHER, LAUNCHER]);
          expect(screenRows(world).every((row) => row.exitedAt !== null)).toBe(true);
          expect((yield* world.screens.ofSession(session.id))?.life).toEqual({
            _tag: "Ended",
            reason: "process-exited",
          });
          expect(yield* engine.screenPasswords(session.id)).toBeNull();
        }),
      { openFails: lost.openFails },
    );
  });

  it.effect("keeps a lost start it could not reap, and a later Stop reaps its display", () => {
    const lost = lostStart(2);
    let reapFails = false;
    return withScreens(
      (world, platform) =>
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
          yield* engine.launch(session.id, ["claude"]);
          lost.arm();
          reapFails = true;
          yield* Effect.flip(engine.startScreen(session.id));
          expect(screenRows(world)).toMatchObject([{ exitedAt: null, sealantSessionId: null }]);
          expect((yield* world.screens.ofSession(session.id))?.life._tag).toBe("Starting");
          expect(yield* engine.screenPasswords(session.id)).toBeNull();

          reapFails = false;
          const reap = screenReapArgv(DisplayNumber.make(10)).join("\n");
          const reapsBefore = platform.execs.filter((argv) => argv.join("\n") === reap).length;
          yield* engine.stopScreen(session.id, "idle");
          const reaps = platform.execs.flatMap((argv, at) =>
            argv.join("\n") === reap ? [platform.execUsers[at]] : [],
          );
          expect(reaps.slice(reapsBefore)).toEqual([LAUNCHER]);
          expect(screenRows(world).every((row) => row.exitedAt !== null)).toBe(true);
          expect((yield* world.screens.ofSession(session.id))?.life).toEqual({
            _tag: "Ended",
            reason: "idle",
          });
        }),
      {
        openFails: lost.openFails,
        reap: () => (reapFails ? Effect.fail(lostReap) : undefined),
      },
    );
  });

  it.effect("refuses a screen in a workspace that cannot give it its own person", () =>
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
            name: "screen",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["claude"]);

          const refused = yield* Effect.flip(engine.startScreen(session.id));
          expect(refused).toMatchObject({
            _tag: "ScreenNeedsPersonError",
            sessionId: session.id,
            message: "this workspace cannot give a screen its own person · no screen was started",
          });
          expect(screenRows(world)).toEqual([]);
          expect(platform.spawned).not.toContainEqual(screenArgv(DisplayNumber.make(10), null));
          expect(yield* engine.screenPasswords(session.id)).toBeNull();
        }),
      { layout: "shared" },
    ),
  );
});
