import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeHarnessLayoutsMemoryState } from "@mend/db";
import { DisplayNumber, SCREEN_LIMITS, type Screen, type Session } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { TestClock, it } from "@mend/test-ci/effect-vitest";
import { Deferred, Duration, Effect, Fiber, Redacted } from "effect";
import { describe, expect } from "vitest";

import {
  onScreenPath,
  screenArgv,
  screenReapArgv,
  screenRekeyArgv,
  screenStartOfArgv,
} from "../src/screen/script.ts";
import { makeWorld, type World } from "./engine/fixture.ts";
import {
  LAUNCHER,
  launched,
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

/** Gives the engine's own fibers `count` turns of the event loop, whatever they do with them. */
const turns = (count: number) =>
  Effect.promise(async () => {
    for (let turn = 0; turn < count; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
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

/** A session joining `worktreeId`'s executor, launched. */
const joinedIn = (worktreeId: Session["worktreeId"]) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const joined = yield* engine.provisionSessionIn(worktreeId, {
      harness: "claude",
      label: null,
      ownerUserId: "user-fixture",
    });
    yield* engine.launch(joined.id, ["claude"]);
    return joined;
  });

const heldDisplays = (world: World) =>
  Effect.map(world.screens.listHeld(), (held) =>
    held.map((screen) => ({ sessionId: screen.sessionId, display: screen.display })),
  );

describe("the session's display for its life (ADR 0020)", () => {
  it.effect(
    "goes back at each Stop, so a hundred joins one after another beside a live session never run out of its ninety displays",
    () =>
      withScreens((world, platform) =>
        Effect.gen(function* () {
          const { engine, session: keeper } = yield* launched(world);
          for (let cycle = 0; cycle < 100; cycle++) {
            const joined = yield* joinedIn(keeper.worktreeId);
            expect(agentOpens(platform).at(-1)?.options?.env?.DISPLAY).toBe(":11");
            yield* engine.stop(joined.id);
            expect(yield* heldDisplays(world)).toEqual([{ sessionId: keeper.id, display: 10 }]);
          }
          expect(agentOpens(platform)).toHaveLength(101);
          expect(agentOpens(platform)[0]?.options?.env?.DISPLAY).toBe(":10");
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect("stays with the session across an idle stop of its screen alone", () =>
    withScreens((world, platform) =>
      Effect.gen(function* () {
        const { engine, session } = yield* launched(world);
        const screen = yield* engine.startScreen(session.id);
        yield* engine.stopScreen(session.id, "idle");
        expect(yield* heldDisplays(world)).toEqual([{ sessionId: session.id, display: 10 }]);

        yield* joinedIn(session.worktreeId);
        expect(agentOpens(platform).at(-1)?.options?.env?.DISPLAY).toBe(":11");
        const again = yield* engine.startScreen(session.id);
        expect({ id: again.id, display: again.display }).toEqual({ id: screen.id, display: 10 });
      }),
    ),
  );

  it.effect("goes back once the session settles with its screen live, and the screen ends", () =>
    withScreens((world) =>
      Effect.gen(function* () {
        const { engine, session: keeper } = yield* launched(world);
        const joined = yield* joinedIn(keeper.worktreeId);
        const screen = yield* engine.startScreen(joined.id);
        yield* engine.stop(joined.id);
        yield* engine.stop(joined.id);
        expect(yield* heldDisplays(world)).toEqual([{ sessionId: keeper.id, display: 10 }]);
        expect((yield* world.screens.byId(screen.id))?.life).toEqual({
          _tag: "Ended",
          reason: "session-stopped",
        });
        expect(world.processes.get(screen.processId ?? "")?.exitedAt).not.toBeNull();
      }),
    ),
  );

  it.effect(
    "signs a screen that outlived its engine for again, as its person, with fresh passwords and no start",
    () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-rekey-")),
      };
      const { world } = fixture;
      const layoutState = makeHarnessLayoutsMemoryState();
      return Effect.gen(function* () {
        const first = yield* withScreens(
          () =>
            Effect.gen(function* () {
              const { engine, session } = yield* launched(world);
              const screen = yield* engine.startScreen(session.id);
              yield* until(
                () => Effect.map(world.screens.byId(screen.id), (now) => now?.life._tag === "Live"),
                "the screen live",
              );
              const passwords = yield* engine.screenPasswords(session.id);
              if (passwords === null) throw new Error("no passwords held");
              return { session, screen, passwords };
            }),
          { fixture, layoutState, printed: ["mend-screen ready"] },
        );
        const row = world.processes.get(first.screen.processId ?? "");
        const asked = row === undefined ? null : screenStartOfArgv(row.argv);
        if (asked === null) throw new Error("no screen process to sign for");

        yield* withScreens(
          (_, platform) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              expect(yield* engine.rekeyScreen(first.session.id)).toBe(false);
              expect(yield* engine.screenPasswords(first.session.id)).toBeNull();
              expect(platform.spawned).toEqual([screenRekeyArgv(asked)]);
              expect(platform.closed).toEqual([screenRekeyArgv(asked)]);
            }),
          { fixture, layoutState, restart: true, rekeyPrinted: [] },
        );

        yield* withScreens(
          (_, platform) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              expect(yield* engine.screenPasswords(first.session.id)).toBeNull();
              expect(yield* engine.rekeyScreen(first.session.id)).toBe(true);
              const passwords = yield* engine.screenPasswords(first.session.id);
              if (passwords === null) throw new Error("no passwords after the rekey");
              expect(Redacted.value(passwords.full)).not.toBe(Redacted.value(first.passwords.full));
              expect(platform.spawned).toEqual([screenRekeyArgv(asked)]);
              expect(platform.opened.at(-1)?.user?.name).toBe(LAUNCHER);
              const handedOver = JSON.stringify([platform.spawned, platform.opened]);
              for (const password of [passwords.full, passwords.viewOnly]) {
                expect(handedOver).not.toContain(Redacted.value(password));
              }
              expect(screenRows(world)).toHaveLength(1);
              expect(world.processes.get(first.screen.processId ?? "")?.exitedAt).toBeNull();
              expect(yield* engine.rekeyScreen(first.session.id)).toBe(true);
              expect(yield* engine.screenPasswords(first.session.id)).toBe(passwords);
              expect(platform.spawned).toHaveLength(1);
            }),
          { fixture, layoutState, restart: true },
        );
      });
    },
  );

  it.effect(
    "gives a rekey up once its deadline passes, its terminal never opened, and holds no passwords",
    () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-rekey-deadline-")),
      };
      const { world } = fixture;
      const layoutState = makeHarnessLayoutsMemoryState();
      return Effect.gen(function* () {
        const first = yield* withScreens(
          () =>
            Effect.gen(function* () {
              const { engine, session } = yield* launched(world);
              const screen = yield* engine.startScreen(session.id);
              yield* until(
                () => Effect.map(world.screens.byId(screen.id), (now) => now?.life._tag === "Live"),
                "the screen live",
              );
              return { session };
            }),
          { fixture, layoutState, printed: ["mend-screen ready"] },
        );
        const opening = yield* Deferred.make<void>();
        yield* withScreens(
          () =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const rekey = yield* Effect.forkChild(engine.rekeyScreen(first.session.id));
              yield* Deferred.await(opening);
              yield* TestClock.adjust(Duration.millis(SCREEN_LIMITS.rekeyMs));
              yield* until(() => Effect.sync(() => rekey.pollUnsafe() !== undefined), "given up");
              expect(yield* Fiber.join(rekey)).toBe(false);
              expect(yield* engine.screenPasswords(first.session.id)).toBeNull();
            }),
          {
            fixture,
            layoutState,
            restart: true,
            aroundOpen: (argv) =>
              argv[3] === "mend-screen-rekey"
                ? Effect.andThen(Deferred.succeed(opening, undefined), Effect.never)
                : Effect.void,
          },
        );
      });
    },
  );

  it.effect(
    "starts a screen its rekey failed for over: the old process stops, and a fresh start holds new passwords",
    () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-rekey-restart-")),
      };
      const { world } = fixture;
      const layoutState = makeHarnessLayoutsMemoryState();
      return Effect.gen(function* () {
        const first = yield* withScreens(
          () =>
            Effect.gen(function* () {
              const { engine, session } = yield* launched(world);
              const screen = yield* engine.startScreen(session.id);
              yield* until(
                () => Effect.map(world.screens.byId(screen.id), (now) => now?.life._tag === "Live"),
                "the screen live",
              );
              return { session, screen };
            }),
          { fixture, layoutState, printed: ["mend-screen ready"] },
        );
        const old = world.processes.get(first.screen.processId ?? "");
        const asked = old === undefined ? null : screenStartOfArgv(old.argv);
        if (old === undefined || asked === null) throw new Error("no screen process to sign for");
        yield* withScreens(
          (_, platform) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              expect(yield* engine.rekeyScreen(first.session.id)).toBe(false);
              const again = yield* engine.startScreen(first.session.id);
              expect(again.id).toBe(first.screen.id);
              expect(again.processId).not.toBe(old.id);
              expect(world.processes.get(old.id)?.exitedAt).not.toBeNull();
              const fresh =
                again.processId === null ? undefined : world.processes.get(again.processId);
              expect(screenStartOfArgv(fresh?.argv ?? [])?.start).not.toBe(asked.start);
              expect(yield* engine.screenPasswords(first.session.id)).not.toBeNull();
              // The old screen's terminal was opened by the engine before, which this fake never saw.
              expect(platform.closed).toEqual([screenRekeyArgv(asked), []]);
            }),
          { fixture, layoutState, restart: true, rekeyPrinted: [], printed: ["mend-screen ready"] },
        );
      });
    },
  );

  it.effect("closes a rekey's terminal that never says it is done once the deadline passes", () => {
    const fixture = {
      world: makeWorld(),
      tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-rekey-running-")),
    };
    const { world } = fixture;
    const layoutState = makeHarnessLayoutsMemoryState();
    return Effect.gen(function* () {
      const first = yield* withScreens(
        () =>
          Effect.gen(function* () {
            const { engine, session } = yield* launched(world);
            const screen = yield* engine.startScreen(session.id);
            yield* until(
              () => Effect.map(world.screens.byId(screen.id), (now) => now?.life._tag === "Live"),
              "the screen live",
            );
            return { session, screen };
          }),
        { fixture, layoutState, printed: ["mend-screen ready"] },
      );
      const row = world.processes.get(first.screen.processId ?? "");
      const asked = row === undefined ? null : screenStartOfArgv(row.argv);
      if (asked === null) throw new Error("no screen process to sign for");
      yield* withScreens(
        (_, platform) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const rekey = yield* Effect.forkChild(engine.rekeyScreen(first.session.id));
            yield* until(() => Effect.sync(() => platform.spawned.length === 1), "opened");
            expect(platform.closed).toEqual([]);
            yield* TestClock.adjust(Duration.millis(SCREEN_LIMITS.rekeyMs));
            expect(yield* Fiber.join(rekey)).toBe(false);
            expect(platform.closed).toEqual([screenRekeyArgv(asked)]);
            expect(yield* engine.screenPasswords(first.session.id)).toBeNull();
          }),
        { fixture, layoutState, restart: true, rekeyPrinted: [], rekeyKeepsRunning: true },
      );
    });
  });

  it.effect("goes back at boot when its session ended without giving it back", () => {
    const fixture = {
      world: makeWorld(),
      tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-boot-")),
    };
    const { world } = fixture;
    return Effect.gen(function* () {
      const { keeper, joined } = yield* withScreens(
        () =>
          Effect.gen(function* () {
            const first = yield* launched(world);
            const second = yield* joinedIn(first.session.worktreeId);
            yield* first.engine.stop(second.id);
            const [kept] = yield* world.screens.listHeld();
            if (kept === undefined) throw new Error("the keeper holds no display");
            yield* world.screens.reserve({ sessionId: second.id, workspaceId: kept.workspaceId });
            return { keeper: first.session, joined: second };
          }),
        { fixture },
      );
      expect(yield* heldDisplays(world)).toEqual([
        { sessionId: keeper.id, display: 10 },
        { sessionId: joined.id, display: 11 },
      ]);

      yield* withScreens(
        () =>
          Effect.andThen(
            SessionEngine,
            until(
              () => Effect.map(world.screens.ofSession(joined.id), (screen) => screen === null),
              "the ended session's display given back",
            ),
          ),
        { fixture, restart: true },
      );
      expect(yield* heldDisplays(world)).toEqual([{ sessionId: keeper.id, display: 10 }]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => fs.rmSync(fixture.tmp, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "stays with a session resumed while boot was giving it back, so the next join gets another",
    () => {
      const fixture = {
        world: makeWorld(),
        tmp: fs.mkdtempSync(path.join(os.tmpdir(), "mend-screen-resume-")),
      };
      return Effect.gen(function* () {
        const { keeper, joined } = yield* withScreens(
          () =>
            Effect.gen(function* () {
              const first = yield* launched(fixture.world);
              const second = yield* joinedIn(first.session.worktreeId);
              yield* first.engine.stop(second.id);
              const [kept] = yield* fixture.world.screens.listHeld();
              if (kept === undefined) throw new Error("the keeper holds no display");
              yield* fixture.world.screens.reserve({
                sessionId: second.id,
                workspaceId: kept.workspaceId,
              });
              return { keeper: first.session, joined: second };
            }),
          { fixture },
        );

        const decided = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const reserving = yield* Deferred.make<void>();
        const { screens } = fixture.world;
        const world: World = {
          ...fixture.world,
          screens: {
            ...screens,
            reserve: (at) =>
              Effect.tap(screens.reserve(at), () =>
                at.sessionId === joined.id ? Deferred.succeed(reserving, undefined) : Effect.void,
              ),
            release: (...held) =>
              Deferred.succeed(decided, undefined).pipe(
                Effect.andThen(Deferred.await(proceed)),
                Effect.andThen(screens.release(...held)),
              ),
          },
        };
        yield* withScreens(
          (_, platform) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              yield* Deferred.await(decided);
              const resume = yield* Effect.forkChild(engine.resumeSession(joined.id, "shell"));
              // The resume goes as far as it can while the release waits: past its own reserve
              // when nothing holds it back, or nowhere, waiting on the gate until the release ends.
              yield* Effect.raceFirst(Deferred.await(reserving), turns(20_000));
              yield* Deferred.succeed(proceed, undefined);
              yield* Fiber.join(resume);
              const resumed = agentOpens(platform).at(-1)?.options?.env?.DISPLAY;
              expect(resumed).toBe(":11");
              expect((yield* world.screens.ofSession(joined.id))?.display).toBe(11);

              yield* joinedIn(keeper.worktreeId);
              expect(agentOpens(platform).at(-1)?.options?.env?.DISPLAY).toBe(":12");
              expect((yield* engine.startScreen(joined.id)).display).toBe(11);
            }),
          { fixture: { world, tmp: fixture.tmp }, restart: true },
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => fs.rmSync(fixture.tmp, { recursive: true, force: true })),
        ),
      );
    },
    { timeout: 30_000 },
  );

  it.effect("is never reserved for a session with no person of its own", () =>
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
          expect(yield* world.screens.listHeld()).toEqual([]);
        }),
      { layout: "shared" },
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
          const argv = platform.spawned.at(-1) ?? [];
          const asked = screenStartOfArgv(argv);
          expect(asked?.dir).toBe(`/run/user/${user?.uid}/mend-screen-10`);
          expect(argv).toEqual(
            screenArgv(DisplayNumber.make(10), { uid: user?.uid ?? -1 }, asked?.start ?? ""),
          );

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

  it.effect(
    "moves to Live on the script's ready line, to degraded when its client fails, and keeps a browser without its sandbox",
    () =>
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
            yield* until(
              () => Effect.map(life(), (now) => now?._tag === "Live" && now.browserSandboxOff),
              "a browser without its sandbox",
            );
            expect(yield* life()).toEqual({
              _tag: "Live",
              degraded: "client-failed",
              browserSandboxOff: true,
            });
          }),
        {
          printed: [
            " vncext: listening",
            "mend-screen ready",
            "mend-screen degraded xfwm4",
            "mend-screen browser sandbox off",
          ],
        },
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
          expect(platform.spawned.filter((argv) => argv[3] === "mend-screen")).toEqual([]);
          expect(yield* engine.screenPasswords(session.id)).toBeNull();
        }),
      { layout: "shared" },
    ),
  );
});

it.effect(
  "a setup session's workspace note leaves out proof capture and automatic preview guidance",
  () =>
    withScreens((world, platform) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        const [project] = [...world.projects.values()];
        if (project === undefined) throw new Error("no project");
        for (const purpose of [null, "setup"] as const) {
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: "Notes",
            name: null,
            start: { kind: "base", base: null },
            ownerUserId: "user-fixture",
            purpose,
          });
          const before = platform.execs.length;
          yield* engine.launch(session.id, ["claude"]);
          const notes = platform.execs.slice(before).flatMap((argv) => {
            const at = argv.indexOf("mend-note");
            return at === -1 ? [] : [argv[at + 1] ?? ""];
          });
          expect(notes.length).toBeGreaterThan(0);
          for (const note of notes) {
            expect(note.includes("## Proof artifacts")).toBe(purpose === null);
            expect(note.includes("Mend prepares the preview")).toBe(purpose === null);
            expect(note.includes("## Mend setup session")).toBe(purpose === "setup");
          }
        }
      }),
    ),
);
