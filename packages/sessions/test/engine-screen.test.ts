import {
  linuxLoginNameOf,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
} from "@mend/db";
import { DisplayNumber, type HarnessLayout, type Screen } from "@mend/domain/workbench";
import type { PersonSessionOptions } from "@mend/sealant";
import {
  ServiceHost,
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  SessionEngine,
} from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect } from "vitest";

import { screenArgv, screenReapArgv } from "../src/screen/script.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";
import { answerLayout, LAYOUT_READY, personPlatform } from "./engine/person-fixture.ts";

const LAUNCHER = linuxLoginNameOf("user-fixture");

const screenRows = (world: World) =>
  [...world.processes.values()].filter((process) => process.kind === "screen");

/** The engine's own fibers run on the event loop: give them turns until `done` holds. */
const until = (done: () => Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200; turn++) {
      if (yield* done()) return;
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    throw new Error(`never observed: ${what}`);
  });

interface Platform {
  readonly spawned: Array<ReadonlyArray<string>>;
  readonly opened: Array<PersonSessionOptions>;
  readonly execs: Array<ReadonlyArray<string>>;
  readonly execUsers: Array<string | null>;
  readonly listeners: Array<string>;
}

/** A person-layout launch of `claude` with a screen beside it, Xvnc's output scripted. */
const withScreens = <A, E>(
  work: (world: World, platform: Platform) => Effect.Effect<A, E, SessionEngine>,
  options: {
    readonly openFails?: () => boolean;
    readonly printed?: ReadonlyArray<string>;
    readonly layout?: HarnessLayout;
    readonly tokensLayer?: Layer.Layer<SessionChannelTokensRepo>;
  } = {},
) => {
  const platform: Platform = { spawned: [], opened: [], execs: [], execUsers: [], listeners: [] };
  const created: Array<CreateOptions> = [];
  return withPreparedEngineEffect(
    (world, tmp) => setup(tmp, world),
    (world) => work(world, platform),
    {
      captured: makeMemoryCaptureStore(),
      ...(options.tokensLayer === undefined ? {} : { tokensLayer: options.tokensLayer }),
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        platform.spawned,
        undefined,
        undefined,
        undefined,
        platform.opened,
        undefined,
        platform.execs,
        undefined,
        {
          execUsers: platform.execUsers,
          exec: answerLayout(LAYOUT_READY),
          ptyOutput: (argv) => (argv[3] === "mend-screen" ? (options.printed ?? []) : []),
          ...(options.openFails === undefined ? {} : { openFails: options.openFails }),
        },
      ),
      harnessLayout: {
        flag: options.layout ?? "person",
        platform: personPlatform([], { person: true }),
      },
      serviceHostLayer: Layer.succeed(ServiceHost, {
        bindAddresses: () => Effect.succeed(["127.0.0.1"]),
        start: (input) =>
          Effect.sync(() => {
            platform.listeners.push(String(input.serviceId));
            return { hostPort: 43127, boundAddresses: ["127.0.0.1"] };
          }),
        hold: () => Effect.void,
        sever: () => Effect.void,
        stop: () => Effect.void,
      }),
    },
  );
};

const lostStart = (failures: number) => {
  let failing = 0;
  return {
    arm: () => {
      failing = failures;
    },
    openFails: () => failing-- > 0,
  };
};

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
          expect(platform.spawned.at(-1)).toEqual(screenArgv(DisplayNumber.make(10)));
          expect(platform.opened.at(-1)?.user?.name).toBe(LAUNCHER);

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

  it.effect("gives up after one reap, and the screen reads ended", () => {
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
          expect(platform.execs.filter((argv) => argv.join("\n") === reap)).toHaveLength(1);
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
          expect(platform.spawned).not.toContainEqual(screenArgv(DisplayNumber.make(10)));
          expect(yield* engine.screenPasswords(session.id)).toBeNull();
        }),
      { layout: "shared" },
    ),
  );
});

const channelLayer = Layer.mergeAll(
  SessionChannelRegistryLive,
  SessionChannelTokensRepoMemory,
  SessionChannelNetworkHostLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionChannelRegistryLive,
        SessionChannelTokensRepoMemory,
        Layer.succeed(DeploymentConfig, {
          mode: "kubernetes",
          sessionEndpoint: { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
          sessionStore: "captured",
        }),
      ),
    ),
  ),
);

describe("the screen's secret over the session channel (ADR 0020)", () => {
  it.live("answers only the person a screen runs as, never a workspace's own token", () =>
    Effect.gen(function* () {
      const registry = yield* SessionChannelRegistry;
      const network = yield* SessionChannelNetworkHost;
      const tokens = yield* SessionChannelTokensRepo;
      for (const layout of ["shared", "person"] as const) {
        yield* withScreens(
          (world) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const [project] = [...world.projects.values()];
              if (project === undefined) throw new Error("no project");
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: `screen-${layout}`,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              const socket = servedSocketApis.get(session.id);
              const launchId = world.executorLaunches.get(session.id)?.launchId;
              if (socket === undefined || launchId === undefined) throw new Error("not launched");
              registry.register(session.id, socket);
              yield* Effect.ignore(engine.startScreen(session.id));
              const ask = (token: string) =>
                Effect.promise(() =>
                  fetch(`http://${network.address}/session/screen-secret`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "x-mend-session-id": session.id },
                  }).then((response) => response.status),
                );
              expect([layout, yield* ask(yield* tokens.issue(session.id, launchId))]).toEqual([
                layout,
                409,
              ]);
              expect([layout, socket.screenSecret]).toEqual([layout, undefined]);
              const person = yield* tokens.issuePerson(launchId, "user-fixture");
              expect([layout, yield* ask(person)]).toEqual([
                layout,
                layout === "person" ? 200 : 401,
              ]);
            }),
          { layout, tokensLayer: Layer.succeed(SessionChannelTokensRepo, tokens) },
        );
      }
    }).pipe(Effect.provide(channelLayer)),
  );
});
