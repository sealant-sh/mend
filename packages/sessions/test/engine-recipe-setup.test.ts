import * as fs from "node:fs";
import * as path from "node:path";

import { type PersonExecOptions, SealantPlatformError } from "@mend/sealant";
import { ForwardAdapter, type ForwardTarget, SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { provisionIn } from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";

const ownerStart = { kind: "person", userId: "user-fixture" } as const;
const ownerStop = { kind: "person", userId: "user-fixture" } as const;

const worktreeOf = (tmp: string, worktree: string) =>
  path.join(tmp, "store", "fixture", "worktrees", worktree);

const write = (tmp: string, worktree: string, file: string, text: string) =>
  fs.writeFileSync(path.join(worktreeOf(tmp, worktree), file), text);

const setupStepOf = (argv: ReadonlyArray<string>) => {
  const at = argv.indexOf("mend-setup");
  return at === -1 ? null : (argv[at + 1] ?? null);
};
const setupRunIdOf = (argv: ReadonlyArray<string>) =>
  argv.find((arg) => arg.startsWith("MEND_SETUP_RUN="))?.slice("MEND_SETUP_RUN=".length) ?? null;
const setupStopRunOf = (argv: ReadonlyArray<string>) => {
  const [, , , tag, runId] = argv;
  return tag === "mend-setup-stop" ? runId : null;
};

const answered = (exitCode: number, stderr = "") => ({ exitCode, stdout: "", stderr });

const WITH_SETUP = `
[setup]
run = ["pnpm install --frozen-lockfile", "pnpm build:deps"]
inputs = ["pnpm-lock.yaml"]

[service.web]
command = "pnpm dev"
port = 3000
depends = ["db"]

[service.db]
command = "postgres"
port = 5432
`;

interface SetupExec {
  readonly step: string;
  readonly cwd: string | undefined;
  readonly opened: ReadonlyArray<ReadonlyArray<string>>;
}

const recordSetup =
  (
    execs: Array<SetupExec>,
    spawned: ReadonlyArray<ReadonlyArray<string>>,
    answer: (step: string) => ReturnType<typeof answered> = () => answered(0),
  ) =>
  (argv: ReadonlyArray<string>, options?: PersonExecOptions) => {
    const step = setupStepOf(argv);
    if (step === null || step === undefined) return undefined;
    return Effect.sync(() => {
      execs.push({ step, cwd: options?.cwd, opened: [...spawned] });
      return answer(step);
    });
  };

const opensOf = (spawned: ReadonlyArray<ReadonlyArray<string>>, command: string) =>
  spawned.filter((argv) => argv.at(-1) === command);

describe("[setup] in a recipe start", () => {
  it("runs first, in the repository, before the dependency and the Service, and stamps its site", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execs: SetupExec[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(tmp, session.worktree, "mend.toml", WITH_SETUP);
          write(tmp, session.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
          const startId = "9b6f3c2e-0c1d-4a7e-8f0a-2d3c4b5a6e7f";

          yield* engine.runServiceRecipe(session.id, "web", ownerStart, startId);

          expect(execs.map((exec) => [exec.step, exec.cwd])).toEqual([
            ["pnpm install --frozen-lockfile", "/workspace/repo"],
            ["pnpm build:deps", "/workspace/repo"],
          ]);
          for (const exec of execs) {
            expect(opensOf(exec.opened, "postgres")).toEqual([]);
            expect(opensOf(exec.opened, "pnpm dev")).toEqual([]);
          }
          expect(opensOf(spawned, "postgres")).toHaveLength(1);
          expect(opensOf(spawned, "pnpm dev")).toHaveLength(1);
          expect(world.setupRuns).toMatchObject([
            {
              siteKey: `host:${session.worktreeId}`,
              worktreeId: session.worktreeId,
              state: "done",
              exitCode: 0,
            },
          ]);
          expect(yield* engine.serviceStartProgress(session.id, startId)).toMatchObject({
            state: "started",
            setup: { state: "ran" },
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { execEffect: recordSetup(execs, spawned) },
        ),
      },
    );
  });

  it("is skipped while its stamp holds, and runs again once an input changes", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execs: SetupExec[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(tmp, session.worktree, "mend.toml", WITH_SETUP);
          write(tmp, session.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          yield* engine.stopServices(session.id, ownerStop);
          expect(execs).toHaveLength(2);

          const unchangedId = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
          yield* engine.runServiceRecipe(session.id, "web", ownerStart, unchangedId);
          expect(execs, "a done stamp skips setup").toHaveLength(2);
          expect(yield* engine.serviceStartProgress(session.id, unchangedId)).toMatchObject({
            setup: { state: "unchanged" },
          });
          yield* engine.stopServices(session.id, ownerStop);

          write(tmp, session.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n");
          yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          expect(execs, "a changed input runs it again").toHaveLength(4);
          expect(web.service.name).toBe("web");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { execEffect: recordSetup(execs, spawned) },
        ),
      },
    );
  });

  it("stops the plan at a failing step, naming it, its exit code and its output's end", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execs: SetupExec[] = [];
    let fails = true;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(tmp, session.worktree, "mend.toml", WITH_SETUP);

          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);
          expect(error.message).toBe(
            "setup did not finish, so nothing was started · `pnpm install --frozen-lockfile` exited 1" +
              "\n--- output ---\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile",
          );
          expect(execs.map((exec) => exec.step)).toEqual(["pnpm install --frozen-lockfile"]);
          expect(opensOf(spawned, "postgres")).toEqual([]);
          expect(opensOf(spawned, "pnpm dev")).toEqual([]);
          expect(world.setupRuns).toMatchObject([{ state: "failed", exitCode: 1 }]);

          const automatic = yield* engine.runServiceRecipe(session.id, "web").pipe(Effect.flip);
          expect(automatic.message).toContain("an automatic start does not run it again");
          expect(execs).toHaveLength(1);

          fails = false;
          yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          expect(execs).toHaveLength(3);
          expect(world.setupRuns).toMatchObject([{ state: "done" }]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            execEffect: recordSetup(execs, spawned, (step) =>
              fails && step.startsWith("pnpm install")
                ? answered(1, "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile")
                : answered(0),
            ),
          },
        ),
      },
    );
  });

  it("refuses an automatic start over a refused [setup], and a person's goes on without it", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execs: SetupExec[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(
            tmp,
            session.worktree,
            "mend.toml",
            '[setup]\nrun = []\n\n[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );
          expect(
            (yield* engine.listServiceRecipes(session.id)).map((recipe) => recipe.name),
          ).toEqual(["web"]);

          const automatic = yield* engine.runServiceRecipe(session.id, "web").pipe(Effect.flip);
          expect(automatic.message).toBe(
            "mend.toml refuses [setup], so web is not started automatically: mend.toml · setup.run · must list at least one command",
          );
          expect(opensOf(spawned, "pnpm dev")).toEqual([]);

          const startId = "6c5b4a39-2817-4f6e-9d5c-4b3a29180f7e";
          yield* engine.runServiceRecipe(session.id, "web", ownerStart, startId);
          expect(opensOf(spawned, "pnpm dev")).toHaveLength(1);
          expect(execs).toEqual([]);
          expect(yield* engine.serviceStartProgress(session.id, startId)).toMatchObject({
            setup: {
              state: "refused",
              reason: "mend.toml · setup.run · must list at least one command",
            },
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { execEffect: recordSetup(execs, spawned) },
        ),
      },
    );
  });
});

const portsAnswer: Layer.Layer<ForwardAdapter> = Layer.succeed(ForwardAdapter, {
  probe: (target: ForwardTarget) =>
    Effect.succeed({
      dialId: "dial",
      purpose: "readiness",
      workspaceId: target.workspaceId,
      port: target.port,
      requested: target.binding,
      lookupMs: 0,
      attempts: [],
      totalMs: 0,
      kind: "ready",
      arrival: { route: "loopback", proof: { kind: "port" } },
    } as const),
  open: () => Effect.die("no HTTP rule in these recipes"),
});

const sessionServices = (world: World, sessionId: string) =>
  [...world.services.values()].filter((service) => service.sessionId === sessionId);

describe("a long [setup]", () => {
  it.effect("holds no permit: another session's Service stops while it runs", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions", "services"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const steps = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const first = yield* provisionIn(project);
            const second = yield* provisionIn(project);
            yield* engine.launch(first.session.id, ["codex"]);
            yield* engine.launch(second.session.id, ["codex"]);
            const api = yield* engine.runService(
              second.session.id,
              ["node", "api.js"],
              4000,
              "api",
            );
            write(tmp, first.session.worktree, "mend.toml", WITH_SETUP);

            const starting = yield* engine
              .runServiceRecipe(first.session.id, "web", ownerStart)
              .pipe(Effect.flip, Effect.forkChild);
            yield* clock.untilChanged(() => steps.length > 0, "setup's first step running");

            yield* engine.stopService(api.service.id, ownerStop);
            expect(steps, "still on its first two-minute step").toEqual([
              "pnpm install --frozen-lockfile",
            ]);
            const stoppedApi = sessionServices(world, second.session.id).find(
              (service) => service.name === "api",
            );
            expect(stoppedApi?.currentAttemptId ?? null).toBeNull();

            yield* TestClock.adjust("2 minutes");
            const held = yield* Fiber.join(starting);
            expect(held.message).toBe(
              "web waits on setup, which has not finished yet · the start goes on · mend service list",
            );
            yield* TestClock.adjust("2 minutes");
            yield* clock.untilChanged(
              () => opensOf(spawned, "pnpm dev").length === 1,
              "web started after setup, with no request waiting",
            );
          }),
        {
          prepareWorld: clock.prepareWorld,
          forwardAdapterLayer: portsAnswer,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              execEffect: (argv) => {
                const step = setupStepOf(argv);
                if (step === null || step === undefined) return undefined;
                return Effect.sync(() => steps.push(step)).pipe(
                  Effect.andThen(Effect.sleep("2 minutes")),
                  Effect.as(answered(0)),
                );
              },
            },
          ),
        },
      );
    }),
  );

  it.effect("is ended by a person's Stop: its processes are stopped and its claim given up", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const stops = clock.watched<string>();
      const running = clock.watched<string>();
      const stepRuns: string[] = [];
      const killed = yield* Deferred.make<void>();
      const startId = "3a2b1c0d-9e8f-4a7b-b6c5-d4e3f2a1b0c9";
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            write(tmp, session.worktree, "mend.toml", WITH_SETUP);
            const request = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart, startId)
              .pipe(Effect.flip, Effect.forkChild);
            yield* clock.untilChanged(() => running.length > 0, "setup running");
            expect(world.setupRuns).toMatchObject([{ state: "running" }]);

            yield* engine.stopServices(session.id, ownerStop);
            yield* clock.untilChanged(() => stops.length > 0, "the setup's processes stopped");
            const error = yield* Fiber.join(request);

            expect(error.message).toBe("a Stop came before web started");
            expect(stops, "the run the step was started under").toEqual(stepRuns);
            expect(world.setupRuns, "the claim is given up, not stamped").toEqual([]);
            expect(opensOf(spawned, "postgres")).toEqual([]);
            expect(opensOf(spawned, "pnpm dev")).toEqual([]);
            expect(running, "the second step never ran").toEqual([
              "pnpm install --frozen-lockfile",
            ]);
            expect(yield* engine.serviceStartProgress(session.id, startId)).toMatchObject({
              state: "stopped",
              setup: { state: "stopped", step: "pnpm install --frozen-lockfile" },
            });
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              execEffect: (argv) => {
                const stopped = setupStopRunOf(argv);
                if (stopped !== null && stopped !== undefined) {
                  return Effect.sync(() => stops.push(stopped)).pipe(
                    Effect.andThen(Deferred.succeed(killed, undefined)),
                    Effect.as(answered(0)),
                  );
                }
                const step = setupStepOf(argv);
                if (step === null || step === undefined) return undefined;
                stepRuns.push(setupRunIdOf(argv) ?? "");
                return Effect.sync(() => running.push(step)).pipe(
                  Effect.andThen(Deferred.await(killed)),
                  Effect.as(answered(143)),
                );
              },
            },
          ),
        },
      );
    }),
  );
});

const ONE_STEP = `
[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]

[service.web]
command = "pnpm dev"
port = 3000

[service.api]
command = "node api.js"
port = 4000
`;

const platformError = (code: string, message: string) =>
  new SealantPlatformError({ code, status: null, message, cause: null });

/**
 * A world whose setup steps each wait to be finished (a processes-stop ends them with `onStop`,
 * 143 unless said), recording each step, the run id it ran under, and every processes-stop.
 */
const blockingSetup = (clock: Effect.Success<ReturnType<typeof makeEngineClock>>, onStop = 143) => {
  const steps = clock.watched<{ readonly step: string; readonly runId: string }>();
  const stops = clock.watched<string>();
  const releases: Array<Deferred.Deferred<number>> = [];
  const execEffect = (argv: ReadonlyArray<string>) => {
    const stopped = setupStopRunOf(argv);
    if (stopped !== null && stopped !== undefined) {
      return Effect.sync(() => stops.push(stopped)).pipe(
        Effect.andThen(
          Effect.forEach(releases, (release) => Deferred.succeed(release, onStop), {
            discard: true,
          }),
        ),
        Effect.as(answered(0)),
      );
    }
    const step = setupStepOf(argv);
    if (step === null) return undefined;
    const release = Deferred.makeUnsafe<number>();
    releases.push(release);
    return Effect.sync(() => steps.push({ step, runId: setupRunIdOf(argv) ?? "" })).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.map((exitCode) => answered(exitCode)),
    );
  };
  const finishStep = (exitCode = 0) =>
    Effect.forEach(releases.splice(0), (release) => Deferred.succeed(release, exitCode), {
      discard: true,
    });
  return { steps, stops, execEffect, finishStep };
};

const layerWith = (
  spawned: ReadonlyArray<string>[],
  ops: Parameters<typeof sealantLaunchLayer>[11],
  stopped?: string[],
) =>
  sealantLaunchLayer(
    [],
    undefined,
    stopped,
    spawned,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ops,
  );

describe("[setup] and the process lifecycle", () => {
  it.effect(
    "keeps its workspace while it runs: a stopped agent's workspace waits for setup, then the Service",
    () =>
      Effect.gen(function* () {
        const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
        const spawned = clock.watched<ReadonlyArray<string>>();
        const stopped = clock.watched<string>();
        const setupWorld = blockingSetup(clock);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const shell = yield* engine.openShell(session.id);
              write(tmp, session.worktree, "mend.toml", ONE_STEP);
              const starting = yield* engine
                .runServiceRecipe(session.id, "web", ownerStart)
                .pipe(Effect.forkChild);
              yield* clock.untilChanged(() => setupWorld.steps.length > 0, "setup running");

              yield* engine.stop(session.id);
              const agentExited = () =>
                [...world.processes.values()].some(
                  (process) => process.kind === "agent-pty" && process.exitedAt !== null,
                );
              yield* clock.untilChanged(agentExited, "the stop ends the agent");
              yield* engine.stopShell(shell.id);
              expect(stopped, "setup holds the workspace").toEqual([]);

              yield* setupWorld.finishStep();
              yield* Fiber.join(starting);
              expect(opensOf(spawned, "pnpm dev")).toHaveLength(1);
              expect(stopped, "then the Service holds it").toEqual([]);
            }),
          {
            prepareWorld: clock.prepareWorld,
            forwardAdapterLayer: portsAnswer,
            sealantLayer: layerWith(spawned, { execEffect: setupWorld.execEffect }, stopped),
          },
        );
      }),
  );
});

describe("one run of [setup] per directory", () => {
  it.effect(
    "a claimant that lost its claim stops its own run, starts nothing, and stamps nothing",
    () =>
      Effect.gen(function* () {
        const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
        const spawned = clock.watched<ReadonlyArray<string>>();
        const setupWorld = blockingSetup(clock);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              write(tmp, session.worktree, "mend.toml", ONE_STEP);
              const starting = yield* engine
                .runServiceRecipe(session.id, "web", ownerStart)
                .pipe(Effect.flip, Effect.forkChild);
              yield* clock.untilChanged(() => setupWorld.steps.length > 0, "setup running");
              const [held] = world.setupRuns;
              if (held === undefined) return yield* Effect.die("no claim");
              world.setupRuns.splice(0, 1, {
                ...held,
                claimId: "taken-over",
                leaseUntil: held.leaseUntil + 600_000,
              });

              yield* TestClock.adjust("20 seconds");
              const error = yield* Fiber.join(starting);

              expect(setupWorld.stops, "its own run, by its marker").toEqual([
                setupWorld.steps[0]?.runId,
              ]);
              expect(error.message).toBe(
                "setup lost its claim on this directory (its lease was not renewed in time), so its run was stopped and nothing was started · start it again",
              );
              expect(world.setupRuns).toMatchObject([{ claimId: "taken-over", state: "running" }]);
              expect(opensOf(spawned, "pnpm dev")).toEqual([]);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: layerWith(spawned, { execEffect: setupWorld.execEffect }),
          },
        );
      }),
  );

  it.effect("stops a lapsed claim's processes before running setup in its directory", () =>
    Effect.gen(function* () {
      const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const order: string[] = [];
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            write(tmp, session.worktree, "mend.toml", ONE_STEP);
            const workspaceId = world.sessions.get(session.id)?.sealantWorkspaceId ?? "";
            world.setupRuns.push({
              siteKey: `host:${session.worktreeId}`,
              fingerprint: "an earlier fingerprint",
              worktreeId: session.worktreeId,
              state: "running",
              claimId: "lapsed-claim",
              workspaceId,
              runsAs: "user-fixture",
              leaseUntil: world.clock.now().getTime() - 10_000,
              finishedAt: null,
              exitCode: null,
              outputTail: null,
            });

            yield* engine.runServiceRecipe(session.id, "web", ownerStart);

            expect(order).toEqual(["stop lapsed-claim", "pnpm install --frozen-lockfile"]);
            expect(world.setupRuns).toMatchObject([{ state: "done", workspaceId }]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          forwardAdapterLayer: portsAnswer,
          sealantLayer: layerWith(spawned, {
            execEffect: (argv) => {
              const stopped = setupStopRunOf(argv);
              if (stopped !== null && stopped !== undefined) {
                return Effect.sync(() => order.push(`stop ${stopped}`)).pipe(
                  Effect.as(answered(0)),
                );
              }
              const step = setupStepOf(argv);
              if (step === null) return undefined;
              return Effect.sync(() => order.push(step)).pipe(Effect.as(answered(0)));
            },
          }),
        },
      );
    }),
  );

  it.effect("a Stop as the last step ends never stamps it done, whatever it exits with", () =>
    Effect.gen(function* () {
      const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      // The step traps TERM and exits 0 as the Stop's processes-stop reaches it.
      const setupWorld = blockingSetup(clock, 0);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            write(tmp, session.worktree, "mend.toml", ONE_STEP);
            const starting = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.flip, Effect.forkChild);
            yield* clock.untilChanged(() => setupWorld.steps.length > 0, "setup running");

            yield* engine.stopServices(session.id, ownerStop);
            const error = yield* Fiber.join(starting);

            expect(error.message).toBe("a Stop came before web started");
            expect(world.setupRuns, "the claim is given up, not stamped").toEqual([]);
            expect(opensOf(spawned, "pnpm dev")).toEqual([]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: layerWith(spawned, { execEffect: setupWorld.execEffect }),
        },
      );
    }),
  );

  it.effect("a start that waited behind another's setup reads its inputs after the wait", () =>
    Effect.gen(function* () {
      const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const setupWorld = blockingSetup(clock);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            write(tmp, session.worktree, "mend.toml", ONE_STEP);
            write(tmp, session.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
            const web = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.forkChild);
            yield* clock.untilChanged(() => setupWorld.steps.length === 1, "web's setup running");
            const apiStart = "5d4c3b2a-1908-4f7e-8d6c-5b4a39281706";
            const api = yield* engine
              .runServiceRecipe(session.id, "api", ownerStart, apiStart)
              .pipe(Effect.forkChild);
            const waiting = Effect.suspend(() =>
              Effect.map(
                engine.serviceStartProgress(session.id, apiStart),
                (progress) => progress?.setup?.reason === "another start is running setup here",
              ),
            );
            // Its inputs are read from disk: real time passes for that, the test clock for the poll.
            for (let look = 0; look < 100 && !(yield* waiting); look++) {
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
              yield* TestClock.adjust("100 millis");
            }
            expect(yield* waiting, "api waits behind web's setup").toBe(true);
            expect(setupWorld.steps).toHaveLength(1);

            write(tmp, session.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# edited\n");
            yield* setupWorld.finishStep();
            yield* Fiber.join(web);
            for (let look = 0; look < 100 && setupWorld.steps.length < 2; look++) {
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
              yield* TestClock.adjust("100 millis");
            }
            expect(setupWorld.steps, "api ran setup over the edited lockfile").toHaveLength(2);
            yield* setupWorld.finishStep();
            yield* Fiber.join(api);
            expect(world.setupRuns).toMatchObject([{ state: "done" }]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          forwardAdapterLayer: portsAnswer,
          sealantLayer: layerWith(spawned, { execEffect: setupWorld.execEffect }),
        },
      );
    }),
  );
});

describe("stopping and reporting a first start's [setup]", () => {
  it.effect("a Stop by the Service's name ends its first start during setup", () =>
    Effect.gen(function* () {
      const clock = yield* makeEngineClock(["processes", "sessions", "setupRuns"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const setupWorld = blockingSetup(clock);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            write(tmp, session.worktree, "mend.toml", ONE_STEP);
            const starting = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.flip, Effect.forkChild);
            yield* clock.untilChanged(() => setupWorld.steps.length > 0, "setup running");
            expect(sessionServices(world, session.id), "no Service row yet").toEqual([]);

            expect(yield* engine.stopServiceStarts(session.id, "api")).toBe(0);
            expect(yield* engine.stopServiceStarts(session.id, "web")).toBe(1);
            const error = yield* Fiber.join(starting);

            expect(error.message).toBe("a Stop came before web started");
            expect(setupWorld.stops).toEqual([setupWorld.steps[0]?.runId]);
            expect(world.setupRuns).toEqual([]);
            expect(opensOf(spawned, "pnpm dev")).toEqual([]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: layerWith(spawned, { execEffect: setupWorld.execEffect }),
        },
      );
    }),
  );

  it("a person's start says in its answer that it went on without a refused [setup]", async () => {
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(
            tmp,
            session.worktree,
            "mend.toml",
            '[setup]\nrun = []\n\n[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );
          const started = yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          expect(started.setup).toMatchObject({
            state: "refused",
            reason: "mend.toml · setup.run · must list at least one command",
          });
        }),
      { sealantLayer: layerWith(spawned, { execEffect: recordSetup([], spawned) }) },
    );
  });

  it("runs setup over a done stamp when the start asks, and again once the workspace image changes", async () => {
    const spawned: ReadonlyArray<string>[] = [];
    const execs: SetupExec[] = [];
    let image = "sha256:node22";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(tmp, session.worktree, "mend.toml", ONE_STEP);
          const run = (options?: { readonly setupAgain?: boolean }) =>
            engine
              .runServiceRecipe(session.id, "web", ownerStart, undefined, options)
              .pipe(Effect.andThen(engine.stopServices(session.id, ownerStop)));
          yield* run();
          yield* run();
          expect(execs, "a done stamp skips it").toHaveLength(1);
          yield* run({ setupAgain: true });
          expect(execs, "asked for").toHaveLength(2);
          image = "sha256:node24";
          yield* run();
          expect(execs, "a new image").toHaveLength(3);
        }),
      {
        sealantLayer: layerWith(spawned, {
          execEffect: recordSetup(execs, spawned),
          bootedImage: () => image,
        }),
      },
    );
  });

  it("records a step the platform stopped waiting for as failed, says why, and stops its processes", async () => {
    const spawned: ReadonlyArray<string>[] = [];
    const stops: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          write(tmp, session.worktree, "mend.toml", ONE_STEP);
          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);
          expect(error.message).toBe(
            "setup did not finish, so nothing was started · `pnpm install --frozen-lockfile` ran past 30 minutes, the longest one setup step may run, so it was stopped",
          );
          expect(stops).toHaveLength(1);
          expect(world.setupRuns).toMatchObject([{ state: "failed", exitCode: null }]);
          expect(opensOf(spawned, "pnpm dev")).toEqual([]);
        }),
      {
        sealantLayer: layerWith(spawned, {
          execEffect: (argv) => {
            const stopped = setupStopRunOf(argv);
            if (stopped !== null && stopped !== undefined) {
              return Effect.sync(() => stops.push(stopped)).pipe(Effect.as(answered(0)));
            }
            return setupStepOf(argv) === null
              ? undefined
              : Effect.fail(
                  platformError("exec_timeout", "Timed out waiting for exec run r-1 to complete."),
                );
          },
        }),
      },
    );
  });
});
