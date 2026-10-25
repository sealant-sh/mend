import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  currentAgentProcess,
  Project,
  Session,
  SessionProcess,
  SessionRun,
  serviceStartCorrelation,
} from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  HarnessStateNotFoundError,
  LegacyBenchReadOnlyError,
  SessionEngine,
  SessionNotLiveError,
} from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { provisionIn } from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  freeLaunchSlot,
  invalidAccount,
  now,
  sealantLaunchLayer,
  setup,
  setupSibling,
  withEngine,
  withEngineEffect,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";
import { adapterLayer, echo, fakeForward, scriptedSealant } from "./forward-fixture.ts";

/**
 * What these scenarios wait on: every row the engine writes (`world.processes`, `world.sessions`,
 * `world.checkpoints`), every stop sent to the platform (`watched`) and every look the PTY
 * watcher takes (`ptyStates` reads).
 */
const makeProcessClock = makeEngineClock(["processes", "sessions", "checkpoints"]);

describe("SessionEngine", () => {
  it("keeps a legacy bench review-only", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: "bench",
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });

          const error = yield* engine.launch(session.id, ["bash"]).pipe(Effect.flip);
          expect(error).toBeInstanceOf(LegacyBenchReadOnlyError);
          expect(created).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("launches a shell session in the image's configured login shell", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });

          // The UI's shell harness always requests ["bash"] — the sentinel for
          // "an interactive shell" — but the PTY must run the image's shell so
          // the owner's dotfiles actually load. Flags ride along.
          yield* engine.launch(session.id, ["bash"]);
          expect(spawned.at(-1)).toEqual(["zsh"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        workspaceImage: {
          mode: "family",
          os: "arch",
          packages: [],
          shell: "zsh",
          services: { docker: false },
        },
      },
    );
  });

  it("runs `bash -c` as bash, its argv untouched, in a zsh image (RC 0.36.0-next.761)", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    // bash-only builtins: zsh answers "command not found" for both.
    const argv = ["bash", "-c", "echo $0; shopt -s extglob && shopt -q extglob && echo ok"];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "run",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });

          // Only the bare `["bash"]` sentinel is the login shell; a bash with arguments is the
          // person's own program.
          yield* engine.launch(session.id, argv);
          const ran = spawned.at(-1);
          expect(ran).toEqual(argv);
          const [program, ...args] = ran ?? [];
          expect(execFileSync(program ?? "", args, { encoding: "utf8" })).toBe("bash\nok\n");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        workspaceImage: {
          mode: "family",
          os: "arch",
          packages: [],
          shell: "zsh",
          services: { docker: false },
        },
      },
    );
  });

  it("keeps the GitHub token when the harness account is unavailable", async () => {
    const created: CreateOptions[] = [];
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

          yield* engine.launch(session.id, ["codex"]);

          expect(created.map((options) => options.credentials)).toEqual([
            { codex: true, claude: true, github: true },
            { codex: true, github: true },
            { codex: true, claude: true },
            { codex: true },
            { github: true },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, (credentials) => credentials?.codex === true),
      },
    );
  });

  describe("the same person's other agent login (docs/adr/0016, decision 5, amended 2026-10-10)", () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
    const launchOnce = (
      harness: "claude" | "codex",
      options: {
        readonly reject?: (
          credentials: CreateOptions["credentials"],
        ) => boolean | SealantPlatformError;
        readonly selectedOnly?: ReadonlySet<string>;
      } = {},
    ) => {
      const created: CreateOptions[] = [];
      return withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            const launched = yield* engine.launch(session.id, [harness]).pipe(Effect.result);
            return { created, launched, session: world.sessions.get(session.id) };
          }),
        {
          sealantLayer: sealantLaunchLayer(created, options.reject ?? (() => false)),
          ...(options.selectedOnly === undefined ? {} : { selectedOnly: options.selectedOnly }),
        },
      );
    };

    it("a Claude session's create names its owner's Codex login too, and starts without it when Codex is not connected", async () => {
      const result = await launchOnce("claude", {
        reject: (credentials) => credentials?.codex === true,
      });
      expect(result.launched._tag).toBe("Success");
      expect(result.created.map((options) => options.credentials)).toEqual([
        { claude: true, codex: true, github: true },
        { claude: true, github: true },
      ]);
    });

    it("a stale login never stops a shared launch: Core's refusal names it, and no later try names it again", async () => {
      const other = await launchOnce("claude", {
        reject: (credentials) =>
          credentials?.codex === undefined ? false : invalidAccount("codex"),
      });
      expect(other.launched._tag).toBe("Success");
      expect(other.created.map((options) => options.credentials)).toEqual([
        { claude: true, codex: true, github: true },
        { claude: true, github: true },
      ]);
      // A shared launch steps past its own refused login too (mend#671): no try names Claude
      // again, and no try names the other agent's login without it.
      const own = await launchOnce("claude", {
        reject: (credentials) =>
          credentials?.claude === undefined ? false : invalidAccount("claude"),
      });
      expect(own.created.map((options) => options.credentials)).toEqual([
        { claude: true, codex: true, github: true },
        { github: true },
      ]);
    });

    it("an owner who chose the selected agent's login only gets a create naming that one and GitHub only", async () => {
      const claude = await launchOnce("claude", { selectedOnly: new Set(["user-fixture"]) });
      expect(claude.created.map((options) => options.credentials)).toEqual([
        { claude: true, github: true },
      ]);
      const codex = await launchOnce("codex", { selectedOnly: new Set(["user-fixture"]) });
      expect(codex.created.map((options) => options.credentials)).toEqual([
        { codex: true, github: true },
      ]);
      // Someone else's choice is not the owner's.
      const other = await launchOnce("codex", { selectedOnly: new Set(["user-other"]) });
      expect(other.created.map((options) => options.credentials)).toEqual([
        { codex: true, claude: true, github: true },
      ]);
    });
  });

  it("gives a shell session the codex account when only codex is connected", async () => {
    // The shell ladder must degrade per provider: a create naming an
    // unconnected account fails whole, so a codex-only user used to fall all
    // the way to `undefined` and open a shell with no agent auth at all.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });

          yield* engine.launch(session.id, ["bash", "-i"]);

          const attempts = created.map((options) => options.credentials);
          expect(attempts.at(-1)).toEqual({ codex: true });
          expect(attempts).toEqual([
            { claude: true, codex: true, github: true },
            { codex: true, github: true },
            { claude: true, github: true },
            { claude: true, codex: true },
            { codex: true },
          ]);
        }),
      {
        // Only codex is connected: any bundle naming claude or github is refused.
        sealantLayer: sealantLaunchLayer(
          created,
          (credentials) => credentials?.claude === true || credentials?.github === true,
        ),
      },
    );
  });

  it.effect("delivers the exact follow-up in a workspace retained by a shell lease", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const stopped = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);

            // A live shell in the same workspace holds a lease (docs/SESSION-SERVICES.md).
            const shell = new SessionProcess({
              id: SessionProcessId.make("shell-1"),
              sessionId: session.id,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              sealantSessionId: "pty-2",
              sealantRunId: null,
              launchCorrelationId: null,
              serviceId: null,
              attemptOrdinal: null,
              kind: "shell",
              harness: null,
              providerSessionId: null,
              protocolOptions: null,
              label: "shell",
              argv: ["bash", "-i"],
              status: "running",
              exitCode: null,
              workspacePort: null,
              protocol: "tcp",
              hostPort: null,
              createdAt: now(),
              exitedAt: null,
              updatedAt: now(),
            });
            world.processes.set(shell.id, shell);

            yield* engine.stop(session.id);
            // The sweep is a forked fiber; wait for it to end the agent's record.
            const agentExited = () =>
              [...world.processes.values()].some(
                (process) => process.kind === "agent-pty" && process.exitedAt !== null,
              );
            yield* clock.untilChanged(agentExited, "the stop's sweep ends the agent's record");

            expect(agentExited()).toBe(true);
            expect(stopped).toEqual([]);
            const retained = [...world.processes.values()].filter(
              (process) => process.exitedAt === null,
            );
            expect(retained.map((process) => process.kind)).toEqual(["shell"]);

            const instruction =
              "  Address exactly the selected Review comments.\nKeep trailing bytes.  ";
            const resumed = yield* engine.launchFollowUp(
              session.id,
              instruction,
              "follow-up:delivery-1",
              "user-fixture",
            );
            expect(resumed.status).toBe("running");
            expect(created).toHaveLength(1);
            expect(stopped).toEqual([]);
            const afterResume = [...world.processes.values()].filter(
              (process) => process.exitedAt === null,
            );
            expect(afterResume.map((process) => process.kind).toSorted()).toEqual([
              "agent-pty",
              "shell",
            ]);
            const deliveryProcess = afterResume.find(
              (process) => process.launchCorrelationId === "follow-up:delivery-1",
            );
            const transportArgv = deliveryProcess?.argv ?? [];
            expect(transportArgv.slice(0, 2)).toEqual(["sh", "-c"]);
            expect(transportArgv[2]).toContain(
              "exec codex -c features.shell_snapshot=false -c features.daemon_auto_start=false -c features.memories=true --dangerously-bypass-approvals-and-sandbox",
            );
            expect(Buffer.from(transportArgv.slice(4).join(""), "base64").toString("utf8")).toBe(
              instruction,
            );
            expect(deliveryProcess?.sealantRunId).not.toBeNull();
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it.effect("stops the workspace when no lease outlives the agent", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const stopped = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);

            yield* engine.stop(session.id);
            yield* clock.untilChanged(
              () => stopped.length > 0,
              "the stop's sweep stops the unleased workspace",
            );

            expect(stopped).toEqual(["workspace-1"]);
            const live = [...world.processes.values()].filter(
              (process) => process.exitedAt === null,
            );
            expect(live).toEqual([]);

            const settledBeforeRetry = world.sessions.get(session.id);
            // Someone else's follow-up never starts the terminal: only the owner types there
            // (docs/adr/0013).
            const teammate = yield* engine
              .launchFollowUp(session.id, "Carol's words.", "follow-up:teammate", "user-2")
              .pipe(Effect.flip);
            expect(teammate).toMatchObject({
              _tag: "SealantPlatformError",
              code: "terminal_owner_only",
            });
            const failure = yield* engine
              .launchFollowUp(
                session.id,
                "This launch cannot restore missing native state.",
                "follow-up:missing-state",
                "user-fixture",
              )
              .pipe(Effect.flip);
            expect(failure).toBeInstanceOf(HarnessStateNotFoundError);
            const settledAfterRetry = world.sessions.get(session.id);
            expect(settledAfterRetry?.status).toBe(settledBeforeRetry?.status);
            expect(settledAfterRetry?.settledAt).toEqual(settledBeforeRetry?.settledAt);
            expect(created).toHaveLength(1);
            expect(
              [...world.processes.values()].some(
                (process) => process.launchCorrelationId === "follow-up:missing-state",
              ),
            ).toBe(false);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it.effect(
    "folds status over processes: a shell keeps the session idle after its agent stops",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeProcessClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const shell = yield* engine.openShell(session.id);
              expect(world.sessions.get(session.id)?.status).toBe("running");

              // Stop ends the AGENT; the shell's lease keeps the worktree's workspace — and the
              // session reads idle, not settled: nothing here is a judgment about the work.
              yield* engine.stop(session.id);
              const afterStop = world.sessions.get(session.id);
              expect(afterStop?.status).toBe("idle");
              expect(afterStop?.settledAt).toBeNull();
              const agent = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty",
              );
              expect(agent?.status).toBe("stopped");
              expect(agent?.harness).toBe("codex");
              const agentRunId = agent?.sealantRunId ?? null;
              expect(agentRunId === null ? null : world.sessionRuns.get(agentRunId)?.status).toBe(
                "stopped",
              );
              // Let the forked tail (harvest, fold) run; the workspace must survive it. The
              // transcript classification is the tail's last write before the fold.
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.hasTranscript !== null,
                "the stop's tail classifies the transcript",
              );
              expect(stopped).toEqual([]);

              // The last lease ends: the fold settles the session from the last agent outcome.
              yield* engine.stopShell(shell.id);
              const settled = world.sessions.get(session.id);
              expect(settled?.status).toBe("stopped");
              expect(settled?.settledAt).not.toBeNull();
              expect(stopped).toEqual(["workspace-1"]);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created, undefined, stopped),
          },
        );
      }),
  );

  it.effect(
    "stop of a shell session closes its other shells too: its own shell is no agent to watch",
    () =>
      Effect.gen(function* () {
        // Box, next.786, 2026-10-11: a `mend shell` beside a shell session's own shell stayed
        // `running` after the session's Stop, and held it `idle` until its own stop.
        const created: CreateOptions[] = [];
        const clock = yield* makeProcessClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "shell",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["bash"]);
              const shell = yield* engine.openShell(session.id);
              // What the observer records for a `claude` typed into it: an agent Mend did not start.
              const sessionShell = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty",
              );
              expect(sessionShell?.harness).toBe("shell");
              const observed = new SessionProcess({
                ...(sessionShell ?? shell),
                id: SessionProcessId.make("observed-claude"),
                kind: "agent-external",
                harness: "claude",
                label: "claude (observed)",
                sealantSessionId: null,
                sealantRunId: null,
                createdAt: now(),
                updatedAt: now(),
              });
              world.processes.set(observed.id, observed);

              yield* engine.stop(session.id);
              for (const id of [sessionShell?.id, shell.id, observed.id]) {
                const row = id === undefined ? undefined : world.processes.get(id);
                expect(row?.status, id).toBe("stopped");
                expect(row?.exitedAt, id).not.toBeNull();
              }
              const after = world.sessions.get(session.id);
              expect(after?.status).toBe("stopped");
              expect(after?.settledAt).not.toBeNull();
              yield* clock.untilChanged(
                () => stopped.length > 0,
                "the stop's sweep stops the workspace nothing holds",
              );
              expect(stopped).toEqual(["workspace-1"]);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created, undefined, stopped),
          },
        );
      }),
  );

  it("stop kills a session held open only by an orphan shell (the refuses-to-die case)", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          // The agent exits on its own (Ctrl+C out of codex): scaffold the
          // post-exit world directly — process ended, run settled, fold idle.
          for (const [id, process] of world.processes) {
            if (process.kind !== "agent-pty") continue;
            world.processes.set(
              id,
              new SessionProcess({
                ...process,
                status: "exited",
                exitCode: 0,
                exitedAt: now(),
                updatedAt: now(),
              }),
            );
            const runId = process.sealantRunId;
            const run = runId === null ? undefined : world.sessionRuns.get(runId);
            if (runId !== null && run !== undefined) {
              world.sessionRuns.set(
                runId,
                new SessionRun({
                  ...run,
                  status: "completed",
                  settledAt: now(),
                  updatedAt: now(),
                }),
              );
            }
          }
          const before = world.sessions.get(session.id);
          if (before !== undefined) {
            world.sessions.set(session.id, new Session({ ...before, status: "idle" }));
          }

          // A stop with NO live agent is aimed at the session itself: the
          // orphan shell closes and the session settles — a 200 that leaves
          // it idle is the refuses-to-die bug.
          yield* engine.stop(session.id);
          const after = world.sessions.get(session.id);
          expect(after?.status).toBe("stopped");
          expect(after?.settledAt).not.toBeNull();
          expect(
            [...world.processes.values()].filter((process) => process.exitedAt === null),
          ).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it.effect(
    "folds an agent exit the watcher observes: idle while a shell holds on, completed after",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeProcessClock;
        const stopped = clock.watched<string>();
        const { ptyStates } = clock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const shell = yield* engine.openShell(session.id);
              const agent = [...world.processes.values()].find(
                (process) => process.kind === "agent-pty",
              );
              if (agent === undefined || agent.sealantSessionId === null) {
                throw new Error("the launch recorded no agent PTY");
              }
              ptyStates.set(agent.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The watcher records the end, then the tail harvests and snapshots; wait for the
              // snapshot — it is the last observable step before the fold.
              const snapshotted = () =>
                world.checkpoints.some((checkpoint) => checkpoint.trigger === "turn-boundary");
              yield* clock.nextLook(
                agent.sealantSessionId,
                () => world.processes.get(agent.id)?.exitedAt === null,
              );
              yield* clock.untilChanged(snapshotted, "the tail snapshots the observed exit");
              expect(world.processes.get(agent.id)?.exitedAt).not.toBeNull();
              expect(world.processes.get(agent.id)?.status).toBe("exited");
              expect(world.sessions.get(session.id)?.status).toBe("idle");
              expect(world.sessions.get(session.id)?.settledAt).toBeNull();
              expect(stopped).toEqual([]);
              // The end of an agent process is a turn boundary. Ordinal 0 is the
              // worktree-start snapshot (no session attached), then the session's own start.
              expect(world.checkpoints.map((checkpoint) => checkpoint.trigger)).toEqual([
                "session-start",
                "session-start",
                "turn-boundary",
              ]);
              expect(world.checkpoints[0]?.sessionId).toBeNull();

              yield* engine.stopShell(shell.id);
              expect(world.sessions.get(session.id)?.status).toBe("completed");
              expect(world.sessions.get(session.id)?.settledAt).not.toBeNull();
              expect(stopped).toEqual(["workspace-1"]);
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

  it.effect("a second agent process joins a session its shell keeps idle", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const stopped = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.openShell(session.id);
            yield* engine.stop(session.id);
            // The stop's forked tail ends with the fold; its transcript classification is its
            // last write before it.
            yield* clock.untilChanged(
              () => world.sessions.get(session.id)?.hasTranscript !== null,
              "the stop's tail classifies the transcript",
            );
            expect(world.sessions.get(session.id)?.status).toBe("idle");

            // Resume as a shell: no saved state needed, and the retained workspace is reused.
            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            expect(created).toHaveLength(1);
            expect(stopped).toEqual([]);
            const agents = [...world.processes.values()]
              .filter((process) => process.kind === "agent-pty")
              .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            expect(agents.map((process) => [process.harness, process.status])).toEqual([
              ["codex", "stopped"],
              ["shell", "running"],
            ]);
            // The session keeps its identity; only the launch ran a shell.
            expect(world.sessions.get(session.id)?.harness).toBe("codex");
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it("refuses a follow-up while any agent process is live", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          const failure = yield* engine
            .launchFollowUp(session.id, "Address the comments.", "follow-up:while-live", null)
            .pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          expect(failure instanceof SealantPlatformError ? failure.code : null).toBe(
            "session_active",
          );
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-pty"),
          ).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell records a live shell process in the session workspace", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);

          const first = yield* engine.openShell(session.id);
          const second = yield* engine.openShell(session.id);
          expect(first.kind).toBe("shell");
          expect(first.label).toBe("shell 1");
          expect(second.label).toBe("shell 2");
          expect(first.sealantWorkspaceId).toBe("workspace-1");

          const renamed = yield* engine.renameShell(first.id, "tests");
          expect(renamed.label).toBe("tests");
          const duplicate = yield* engine.renameShell(second.id, "tests").pipe(Effect.flip);
          expect(duplicate.message).toContain("already exists");

          const stopped = yield* engine.stopShell(first.id);
          expect(stopped.status).toBe("stopped");
          const stoppedAgain = yield* engine.stopShell(first.id);
          expect(stoppedAgain.status).toBe("stopped");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.kind).toSorted()).toEqual(["agent-pty", "shell"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell refuses a session that has no workspace", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          start: { kind: "base", base: null },
        });

        const outcome = yield* engine.openShell(session.id).pipe(Effect.flip);
        expect(outcome).toBeInstanceOf(SessionNotLiveError);
      }),
    );
  });

  it("records the exact platform expiry when a new agent lease renews its workspace", async () => {
    const created: CreateOptions[] = [];
    const renewals: Array<{ readonly workspaceId: string; readonly ttlSeconds: number }> = [];
    const exactExpiry = new Date("2031-02-03T04:05:06.000Z");
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

          const launched = yield* engine.launch(session.id, ["codex"]);

          expect(renewals).toEqual([{ workspaceId: "workspace-1", ttlSeconds: 43_200 }]);
          expect(launched.workspaceExpiresAt).toEqual(exactExpiry);
          expect(launched.workspaceTtlRenewedAt).not.toBeNull();
          expect(launched.workspaceTtlRenewalFailedAt).toBeNull();
          expect(launched.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          (workspaceId, ttlSeconds) =>
            Effect.sync(() => {
              renewals.push({ workspaceId, ttlSeconds });
              return exactExpiry;
            }),
        ),
      },
    );
  });

  it("preserves known expiry on renewal failure and clears the failure after recovery", async () => {
    const created: CreateOptions[] = [];
    const firstExpiry = new Date("2031-02-03T04:05:06.000Z");
    const recoveredExpiry = new Date("2031-02-03T16:05:06.000Z");
    let renewalAttempt = 0;
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
          yield* engine.launch(session.id, ["codex"]);
          const afterSuccess = world.sessions.get(session.id);
          const firstRenewedAt = afterSuccess?.workspaceTtlRenewedAt ?? null;
          expect(afterSuccess?.workspaceExpiresAt).toEqual(firstExpiry);

          yield* engine.openShell(session.id);
          const afterFailure = world.sessions.get(session.id);
          expect(afterFailure?.workspaceExpiresAt).toEqual(firstExpiry);
          expect(afterFailure?.workspaceTtlRenewedAt).toEqual(firstRenewedAt);
          expect(afterFailure?.workspaceTtlRenewalFailedAt).not.toBeNull();
          expect(afterFailure?.workspaceTtlRenewalError).toBe("renewal unavailable");

          yield* engine.openShell(session.id);
          const afterRecovery = world.sessions.get(session.id);
          expect(afterRecovery?.workspaceExpiresAt).toEqual(recoveredExpiry);
          expect(afterRecovery?.workspaceTtlRenewalFailedAt).toBeNull();
          expect(afterRecovery?.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          () => {
            renewalAttempt += 1;
            if (renewalAttempt === 2) {
              return Effect.fail(
                new SealantPlatformError({
                  code: "workspace_expiry_failed",
                  status: 503,
                  message: "renewal unavailable",
                  cause: null,
                }),
              );
            }
            return Effect.succeed(renewalAttempt === 1 ? firstExpiry : recoveredExpiry);
          },
        ),
      },
    );
  });

  it.effect("renews a retained shell workspace during boot recovery", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const renewals: string[] = [];
      const sessionId = SessionId.make("session-retained-at-boot");
      const workspaceId = SealantWorkspaceId.make("workspace-1");
      const exactExpiry = new Date("2032-01-01T00:00:00.000Z");
      const clock = yield* makeProcessClock;
      // No origin to adopt: the engine's boot sweep is the whole scenario.
      yield* withEngineEffect(
        (world) =>
          Effect.gen(function* () {
            yield* clock.untilChanged(
              () =>
                world.sessions.get(sessionId)?.workspaceExpiresAt?.getTime() ===
                exactExpiry.getTime(),
              "the boot sweep renews the retained workspace",
            );
            expect(renewals).toContain(workspaceId);
            const renewed = world.sessions.get(sessionId);
            expect(renewed?.workspaceTtlRenewedAt).not.toBeNull();
            expect(renewed?.workspaceTtlRenewalError).toBeNull();
          }),
        {
          prepareWorld: (world) => {
            clock.prepareWorld(world);
            const timestamp = now();
            world.sessions.set(
              sessionId,
              new Session({
                id: sessionId,
                projectId: ProjectId.make("project-retained-at-boot"),
                worktreeId: WorktreeId.make("wt-retained-at-boot"),
                harness: "codex",
                providerSessionId: null,
                label: null,
                worktree: "session-retained-at-boot",
                branch: "mend/session-retained-at-boot",
                baseSha: Sha.make("base-sha"),
                baseRef: "main",
                contextSnapshotId: null,
                referenceMounts: [],
                extraMounts: [],
                sealantRunId: null,
                sealantWorkspaceId: workspaceId,
                sealantSessionId: null,
                workspaceExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
                workspaceTtlRenewedAt: new Date("2029-12-31T12:00:00.000Z"),
                workspaceTtlRenewalFailedAt: null,
                workspaceTtlRenewalError: null,
                workspaceImage: null,
                dotfiles: null,
                ownerUserId: "user-fixture",
                hasTranscript: null,
                status: "completed",
                summary: null,
                lastSeenSequence: 0n,
                recordHistoryComplete: true,
                startedAt: timestamp,
                settledAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              }),
            );
            world.processes.set(
              "shell-retained-at-boot",
              new SessionProcess({
                id: SessionProcessId.make("shell-retained-at-boot"),
                sessionId,
                sealantWorkspaceId: workspaceId,
                sealantSessionId: "pty-1",
                sealantRunId: SealantRunId.make("run-shell-retained-at-boot"),
                launchCorrelationId: null,
                serviceId: null,
                attemptOrdinal: null,
                kind: "shell",
                harness: null,
                providerSessionId: null,
                protocolOptions: null,
                label: "shell 1",
                argv: ["sh"],
                status: "running",
                exitCode: null,
                workspacePort: null,
                protocol: "tcp",
                hostPort: null,
                createdAt: timestamp,
                exitedAt: null,
                updatedAt: timestamp,
              }),
            );
          },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            (candidateWorkspaceId) =>
              Effect.sync(() => {
                renewals.push(candidateWorkspaceId);
                return exactExpiry;
              }),
          ),
        },
      );
    }),
  );

  it.effect("addService adopts a port; its lease outlives the agent until stopService", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const stopped = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);

            const service = yield* engine.addService(session.id, 5432, "db");
            expect(service.service.name).toBe("db");
            expect(service.service.workspacePort).toBe(5432);
            expect(service.attempts).toHaveLength(0);
            expect(service.currentForward?.hostPort).toBe(43127);
            expect(service.latestObservation?.state).toBe("reachable");
            const adoptedRestart = yield* engine
              .restartService(service.service.id)
              .pipe(Effect.flip);
            expect(adoptedRestart.message).toContain("no recorded command");

            // A live name is taken — a second "db" is refused, not duplicated.
            const duplicate = yield* engine.addService(session.id, 5433, "db").pipe(Effect.flip);
            expect(String(duplicate.message)).toContain('named "db" already exists');

            // The agent settles; the Service lease keeps the workspace up.
            yield* engine.stop(session.id);
            const agentExited = () =>
              [...world.processes.values()].some(
                (process) => process.kind === "agent-pty" && process.exitedAt !== null,
              );
            yield* clock.untilChanged(agentExited, "the stop ends the agent's record");
            expect(agentExited()).toBe(true);
            expect(stopped).toEqual([]);

            // A completed coding-agent run may open another supporting process
            // while the Service retains the reachable workspace.
            const shell = yield* engine.openShell(session.id);
            expect(shell.label).toBe("shell 1");

            const ended = yield* engine.stopService(service.service.id);
            expect(ended.service.currentAttemptId).toBeNull();
            expect(ended.service.currentForwardId).toBeNull();
            expect(stopped).toEqual([]);
            yield* engine.stopShell(shell.id);
            expect(stopped).toEqual(["workspace-1"]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it.effect(
    "stopServices stops every live Service a stopped agent left behind, then the workspace",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeProcessClock;
        const stopped = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              const web = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
              const db = yield* engine.addService(session.id, 5432, "db");
              const ended = yield* engine.runService(
                session.id,
                ["pnpm", "worker"],
                4000,
                "worker",
              );
              yield* engine.stopService(ended.service.id);

              yield* engine.stop(session.id);
              const agentExited = () =>
                [...world.processes.values()].some(
                  (process) => process.kind === "agent-pty" && process.exitedAt !== null,
                );
              yield* clock.untilChanged(agentExited, "the stop ends the agent's record");
              // The stop ended the agent; two Services still hold the workspace.
              expect(stopped).toEqual([]);

              expect(yield* engine.stopServices(session.id)).toBe(2);
              expect(world.services.get(web.service.id)?.currentAttemptId).toBeNull();
              expect(world.services.get(db.service.id)?.currentForwardId).toBeNull();
              expect(stopped).toEqual(["workspace-1"]);
              expect(world.sessions.get(session.id)?.status).toBe("stopped");
              // Nothing left: a second press stops nothing and says so.
              expect(yield* engine.stopServices(session.id)).toBe(0);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created, undefined, stopped),
          },
        );
      }),
  );

  it.effect("reuses a workspace retained only by an adopted Service; fresh resume closes it", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const stopped = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const view = yield* engine.addService(session.id, 5432, "db");
            yield* engine.stop(session.id);

            const agentsSettled = () =>
              [...world.processes.values()]
                .filter((process) => process.kind === "agent-pty")
                .every((process) => process.exitedAt !== null);
            yield* clock.untilChanged(agentsSettled, "the first stop ends the agent's record");

            yield* engine.resumeSession(session.id, "shell");
            expect(created).toHaveLength(1);
            expect(stopped).toEqual([]);
            expect(world.services.get(view.service.id)?.currentForwardId).not.toBeNull();

            yield* engine.stop(session.id);
            yield* clock.untilChanged(agentsSettled, "the second stop ends the shell's record");
            yield* engine.resumeSession(session.id, "shell", true);
            expect(created).toHaveLength(2);
            expect(stopped).toEqual(["workspace-1"]);
            expect(world.services.get(view.service.id)?.currentForwardId).toBeNull();
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        },
      );
    }),
  );

  it("runService restart appends attempts and preserves prior run pointers", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);

          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(service.service.name).toBe("web");
          expect(service.attempts).toHaveLength(1);
          expect(service.attempts[0]?.sealantSessionId).not.toBeNull();
          expect(service.attempts[0]?.argv).toEqual(["pnpm", "dev"]);
          expect(service.attempts[0]?.status).toBe("running");
          expect(service.currentForward?.hostPort).toBe(43127);
          expect(service.latestObservation?.state).toBe("reachable");

          const firstAttemptId = service.attempts[0]?.id;
          const firstRunId = service.attempts[0]?.sealantRunId;
          const forwardId = service.currentForward?.id;
          const restarted = yield* engine.restartService(service.service.id);
          expect(restarted.service.id).toBe(service.service.id);
          expect(restarted.attempts).toHaveLength(2);
          expect(restarted.attempts[0]?.id).toBe(firstAttemptId);
          expect(restarted.attempts[0]?.sealantRunId).toBe(firstRunId);
          expect(restarted.attempts[0]?.status).toBe("stopped");
          expect(restarted.attempts[1]?.id).not.toBe(firstAttemptId);
          expect(restarted.attempts[1]?.sealantRunId).not.toBe(firstRunId);
          expect(restarted.attempts[1]?.status).toBe("running");
          expect(restarted.currentForward?.id).toBe(forwardId);

          const stopped = yield* engine.stopService(service.service.id);
          expect(stopped.service.currentAttemptId).toBeNull();
          expect(stopped.service.currentForwardId).toBeNull();
          expect(stopped.attempts.at(-1)?.status).toBe("stopped");

          const rerun = yield* engine.runService(
            session.id,
            stopped.attempts.at(-1)?.argv ?? [],
            stopped.service.workspacePort,
            stopped.service.name,
            stopped.service.transport,
          );
          expect(rerun.service.id).toBe(service.service.id);
          expect(rerun.attempts).toHaveLength(3);
          expect(rerun.service.currentAttemptId).toBe(rerun.attempts.at(-1)?.id);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("ends a Service's readiness wait at once when its workspace is gone, and says why", async () => {
    const created: CreateOptions[] = [];
    const gone = scriptedSealant(
      async () => fakeForward(echo).forward,
      () =>
        Effect.fail(
          new SealantPlatformError({
            code: "WorkspaceNotFoundError",
            status: 404,
            message: "no such workspace",
            cause: null,
          }),
        ),
    );
    const started = Date.now();
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
          yield* engine.launch(session.id, ["codex"]);
          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(service.latestObservation).toMatchObject({
            state: "unreachable",
            error: "not-found",
          });
          expect(gone.ledger.lookups).toBe(1);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        forwardAdapterLayer: adapterLayer(gone.layer, "refuse"),
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stamps a start's id on the attempt it began, and refuses the id a second time", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          const startId = "5b3f0c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";

          const service = yield* engine.runService(
            session.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            null,
            undefined,
            startId,
          );
          expect(service.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(service.service.id, startId),
          );
          yield* engine.stopService(service.service.id);

          const again = yield* engine
            .runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", null, undefined, startId)
            .pipe(Effect.flip);
          expect(again._tag).toBe("ServiceStartError");
          expect(again.message).toContain(
            "This start id was used by an earlier start of this Service",
          );

          // Another Service of the session takes the same id: the key is the Service and the id.
          const api = yield* engine.runService(
            session.id,
            ["pnpm", "api"],
            4000,
            "api",
            "tcp",
            null,
            undefined,
            startId,
          );
          expect(api.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(api.service.id, startId),
          );

          // A start that names no id carries none: an older client's starts are as before.
          const unnamed = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(unnamed.attempts.at(-1)?.launchCorrelationId).toBeNull();
          expect(unnamed.attempts).toHaveLength(2);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  // Review 2 of mend#651: an id another person used on their own private work, in the same
  // organization or another, neither refuses this person's start nor says it was used.
  it.each([
    { who: "carol", organization: "org-test" },
    { who: "bob", organization: "org-bob" },
  ])(
    "a start id another person used on hidden work is invisible to $who's own start ($organization)",
    async ({ who, organization }) => {
      const created: CreateOptions[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const fixture = yield* setup(tmp, world);
            const alicesProject = new Project({
              ...fixture,
              visibility: "private",
              createdByUserId: "user-fixture",
            });
            world.projects.set(alicesProject.id, alicesProject);
            const sibling = yield* setupSibling(tmp, world, who, fixture.originUrl ?? "");
            const theirProject = new Project({
              ...sibling,
              organizationId: OrganizationId.make(organization),
              visibility: "private",
              createdByUserId: `user-${who}`,
            });
            world.projects.set(theirProject.id, theirProject);
            const engine = yield* SessionEngine;
            const startId = "5b3f0c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";

            const alice = yield* engine.provision({
              projectId: alicesProject.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(alice.id, ["codex"]);
            const hers = yield* engine.runService(
              alice.id,
              ["pnpm", "dev"],
              3000,
              "web",
              "tcp",
              null,
              "user-fixture",
              startId,
            );
            yield* engine.stopService(hers.service.id);

            const theirs = yield* engine.provision({
              projectId: theirProject.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: `user-${who}`,
              start: { kind: "base", base: null },
            });
            yield* engine.launch(theirs.id, ["codex"]);
            // The same name too: nothing of Alice's Service decides theirs.
            const started = yield* engine.runService(
              theirs.id,
              ["pnpm", "dev"],
              3001,
              "web",
              "tcp",
              null,
              `user-${who}`,
              startId,
            );
            expect(started.service.sessionId).toBe(theirs.id);
            expect(started.attempts).toHaveLength(1);
            expect(started.attempts[0]?.status).toBe("running");
            expect(started.attempts[0]?.launchCorrelationId).toBe(
              serviceStartCorrelation(started.service.id, startId),
            );
            expect(started.attempts[0]?.launchCorrelationId).not.toBe(
              hers.attempts[0]?.launchCorrelationId,
            );
          }),
        { sealantLayer: sealantLaunchLayer(created) },
      );
    },
  );

  it("stamps a recipe start's id on its attempt", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
          fs.writeFileSync(
            path.join(worktree, "mend.toml"),
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );
          const startId = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b";
          const service = yield* engine.runServiceRecipe(session.id, "web", undefined, startId);
          expect(service.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(service.service.id, startId),
          );
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("stamps server-resolved file recipe provenance", async () => {
    const created: CreateOptions[] = [];
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
          yield* engine.launch(session.id, ["codex"]);
          const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
          fs.writeFileSync(
            path.join(worktree, "mend.toml"),
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );

          const service = yield* engine.runServiceRecipe(session.id, "web");
          expect(service.service.name).toBe("web");
          expect(service.service.declarationSource).toBe("recipe-file");
          expect(service.attempts[0]?.argv).toEqual(["sh", "-c", "pnpm dev"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it.effect("keeps a Service live across a transient watcher lookup failure", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      const { ptyStates } = clock;
      // The Service attempt's watcher looks its PTY up by id; the first such lookup is refused
      // the way a control plane that does not answer refuses it (503, not a 404 that says gone).
      let rows: World["processes"] | undefined;
      const servicePty = (ptyId: string) =>
        [...(rows?.values() ?? [])].some(
          (process) => process.kind === "service" && process.sealantSessionId === ptyId,
        );
      const serviceLookups = clock.watched<"refused" | "answered">();
      const wrapSealant = (layer: Layer.Layer<SealantClient>): Layer.Layer<SealantClient> =>
        Layer.effect(
          SealantClient,
          Effect.map(SealantClient, (inner) => ({
            ...inner,
            getSession: (workspace, ptyId) =>
              Effect.suspend(() => {
                if (!servicePty(ptyId)) return inner.getSession(workspace, ptyId);
                const refused = serviceLookups.length === 0;
                serviceLookups.push(refused ? "refused" : "answered");
                return refused
                  ? Effect.fail(
                      new SealantPlatformError({
                        code: "control_plane_unavailable",
                        status: 503,
                        message: "the control plane did not answer",
                        cause: null,
                      }),
                    )
                  : inner.getSession(workspace, ptyId);
              }),
          })),
        ).pipe(Layer.provide(layer));
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
            const attemptId = service.service.currentAttemptId ?? "";
            const attemptPty = world.processes.get(attemptId)?.sealantSessionId ?? "";
            yield* clock.untilChanged(
              () => serviceLookups.length >= 1,
              "the attempt's watcher looks its PTY up and is refused",
            );
            expect(serviceLookups).toEqual(["refused"]);
            // Blindness is retried, never read as an exit: SUPERVISE_RETRY asks again after 1 s
            // (its first exponential delay), and nothing is asked before that.
            yield* TestClock.adjust(999);
            expect(serviceLookups).toEqual(["refused"]);
            yield* TestClock.adjust(1);
            yield* clock.untilChanged(
              () => serviceLookups.length >= 2,
              "the watcher's retry looks the PTY up again",
            );
            expect(serviceLookups).toEqual(["refused", "answered"]);
            // Back on its 2 s looks, the watcher finds the attempt running and keeps it.
            yield* clock.nextLook(
              attemptPty,
              () => world.processes.get(attemptId)?.exitedAt === null,
            );

            const attempt = world.processes.get(service.service.currentAttemptId ?? "");
            expect(attempt?.exitedAt).toBeNull();
            expect(world.services.get(service.service.id)?.currentForwardId).not.toBeNull();
          }),
        {
          prepareWorld: (world) => {
            clock.prepareWorld(world);
            rows = world.processes;
          },
          sealantLayer: wrapSealant(
            sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              ptyStates,
            ),
          ),
        },
      );
    }),
  );

  it("does not append a restart attempt when the workspace lookup fails", async () => {
    const created: CreateOptions[] = [];
    let rejectWorkspaceLookup = false;
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
          yield* engine.launch(session.id, ["codex"]);
          const before = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          rejectWorkspaceLookup = true;
          const failure = yield* engine.restartService(before.service.id).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          const attempts = [...world.processes.values()].filter(
            (process) => process.serviceId === before.service.id,
          );
          expect(attempts).toHaveLength(1);
          expect(world.services.get(before.service.id)?.currentAttemptId).toBe(attempts[0]?.id);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          () => rejectWorkspaceLookup,
        ),
      },
    );
  });

  it("resumes a provisioned-but-never-launched session as a workbench shell", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          // The editor's workbench flow: create only — no launch — then shell-resume.
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          expect(session.status).toBe("starting");

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          // The default image's login shell (zsh), not the `bash` request sentinel.
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("holds a provisioned session's workspace with no agent: one live shell, which is the session's terminal, and no run of its harness", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
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
          const held = yield* engine.holdWorkspace(session.id, freeLaunchSlot);
          expect(held.status).toBe("idle");
          expect(held.settledAt).toBeNull();
          const rows = [...world.processes.values()].filter(
            (process) => process.sessionId === session.id,
          );
          expect(rows.map((process) => [process.kind, process.label, process.status])).toEqual([
            ["shell", "shell 1", "running"],
          ]);
          // The session TTY route attaches to the newest agent's PTY, else to the session's own
          // PTY pointer: with no agent, that pointer is the live shell.
          expect(currentAgentProcess(rows)).toBeNull();
          expect(held.sealantSessionId).toBe(rows[0]?.sealantSessionId);
          expect(held.sealantRunId).toBeNull();
          expect(
            [...world.sessionRuns.values()].filter((run) => run.sessionId === session.id),
          ).toEqual([]);
          expect(spawned).toHaveLength(1);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
      },
    );
  });

  it("reads a hold still opening as starting, with its launch under way, and idle once the shell holds it", async () => {
    const created: CreateOptions[] = [];
    const opening = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
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
          const holding = yield* Effect.forkChild(engine.holdWorkspace(session.id, freeLaunchSlot));
          yield* Deferred.await(opening);
          expect(world.sessions.get(session.id)?.status).toBe("starting");
          expect(engine.launchUnderWay(session.id)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          const held = yield* Fiber.join(holding);
          expect(held.status).toBe("idle");
          expect(engine.launchUnderWay(session.id)).toBe(false);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
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
            aroundOpen: () =>
              Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(release))),
          },
        ),
      },
    );
  });

  it("settles a hold failed when its shell cannot open in the workspace it made, and records no process", async () => {
    const created: CreateOptions[] = [];
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
          const outcome = yield* engine
            .holdWorkspace(session.id, freeLaunchSlot)
            .pipe(Effect.result);
          expect(Result.isFailure(outcome)).toBe(true);
          expect(created).toHaveLength(1);
          const row = world.sessions.get(session.id);
          expect(row?.status).toBe("failed");
          expect(row?.summary).toMatch(/the platform did not open the session/);
          expect(
            [...world.processes.values()].filter((process) => process.sessionId === session.id),
          ).toEqual([]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
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
          { openFails: () => true },
        ),
      },
    );
  });

  it("holds a session that joins another session's executor as one shell: no agent, no run, the holder's workspace", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["codex"]);
          const joiner = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: "user-fixture",
          });
          const held = yield* engine.holdWorkspace(joiner.id, freeLaunchSlot);
          expect(created).toHaveLength(1);
          expect(held.status).toBe("idle");
          expect(held.sealantWorkspaceId).toBe(world.sessions.get(holder.id)?.sealantWorkspaceId);
          expect(held.sealantRunId).toBeNull();
          const rows = [...world.processes.values()].filter(
            (process) => process.sessionId === joiner.id,
          );
          expect(rows.map((process) => [process.kind, process.label, process.status])).toEqual([
            ["shell", "shell 1", "running"],
          ]);
          expect(currentAgentProcess(rows)).toBeNull();
          expect(held.sealantSessionId).toBe(rows[0]?.sealantSessionId);
          expect(
            [...world.sessionRuns.values()].filter((run) => run.sessionId === joiner.id),
          ).toEqual([]);
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("answers a late hold with the session as it stands: the agent another launch started keeps running, in its workspace", async () => {
    const created: CreateOptions[] = [];
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
          const launched = yield* engine.launch(session.id, ["codex", "finish the tests"]);
          const held = yield* engine.holdWorkspace(session.id, freeLaunchSlot);
          expect(held.status).toBe("running");
          expect(held.sealantWorkspaceId).toBe(launched.sealantWorkspaceId);
          expect(held.sealantRunId).toBe(launched.sealantRunId);
          expect(created).toHaveLength(1);
          expect(
            [...world.processes.values()]
              .filter((process) => process.sessionId === session.id)
              .map((process) => [process.kind, process.status]),
          ).toEqual([["agent-pty", "running"]]);
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("answers a hold that meets a launch still starting with the session as it stands, and never settles that launch failed", async () => {
    const created: CreateOptions[] = [];
    const opening = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
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
          const launching = yield* Effect.forkChild(
            engine.launch(session.id, ["codex", "finish the tests"]),
          );
          yield* Deferred.await(opening);
          const held = yield* engine.holdWorkspace(session.id, freeLaunchSlot);
          expect(held.status).toBe("starting");
          expect(held.settledAt).toBeNull();
          yield* Deferred.succeed(release, undefined);
          const launched = yield* Fiber.join(launching);
          expect(launched.status).toBe("running");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          expect(created).toHaveLength(1);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
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
            aroundOpen: () =>
              Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(release))),
          },
        ),
      },
    );
  });

  it("settles a hold refused a launch slot failed in the slot's words, and starts nothing", async () => {
    const created: CreateOptions[] = [];
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
          const held = yield* engine.holdWorkspace(session.id, {
            take: () => Effect.succeed(null),
            refused: "budget reached · 4 launches starting at once for one account",
          });
          expect(held.status).toBe("failed");
          expect(held.summary).toBe(
            "hold failed: budget reached · 4 launches starting at once for one account",
          );
          expect(created).toEqual([]);
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("refuses a hold under the co-located store with a typed error, and starts and settles nothing", async () => {
    const created: CreateOptions[] = [];
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
          const refused = yield* engine.holdWorkspace(session.id, freeLaunchSlot).pipe(Effect.flip);
          expect(refused._tag).toBe("HoldUnsupportedError");
          expect(created).toEqual([]);
          expect(world.sessions.get(session.id)?.status).toBe("starting");
          expect(world.sessions.get(session.id)?.sealantRunId).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it.effect("resumes a settled session with shell — no saved state required", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeProcessClock;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            const agentExited = () =>
              [...world.processes.values()].every((process) => process.exitedAt !== null);
            yield* clock.untilChanged(agentExited, "the stop ends the agent's record");

            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            // The session keeps its harness identity — only this launch is a shell.
            expect(resumed.harness).toBe("codex");
            const live = [...world.processes.values()].filter(
              (process) => process.exitedAt === null,
            );
            // The default image's login shell (zsh), not the `bash` request sentinel.
            expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created),
        },
      );
    }),
  );
});
