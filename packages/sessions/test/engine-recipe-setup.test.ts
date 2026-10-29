import * as fs from "node:fs";
import * as path from "node:path";

import type { PersonExecOptions } from "@mend/sealant";
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
  const [, , , tag, , step] = argv;
  return tag === "mend-setup" ? step : null;
};
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
              siteKey: `host:${fs.realpathSync(worktreeOf(tmp, session.worktree))}`,
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
                stepRuns.push(argv[4] ?? "");
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
