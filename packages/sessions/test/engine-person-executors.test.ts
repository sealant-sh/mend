// Executors and their homes per person (docs/adr/0016, Delivery 19): pre-release executors, the
// migration of an old shared home and its memory, and agents run by hand in the head capture.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  WorktreesRepo,
  AgentMemoryRepo,
  type HarnessLayoutsMemoryState,
  makeHarnessLayoutsMemoryState,
  type AgentMemoryHomes,
  type PreReleaseMigrationRecord,
} from "@mend/db";
import { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import {
  AgentTurn,
  type HostUserNamespaces,
  type WorkspaceRetirement,
  Session,
} from "@mend/domain/workbench";
import { type CaptureFlushKind, SealantPlatformError } from "@mend/sealant";
import {
  ProtocolHost,
  Restart,
  SessionEngine,
  SessionTurnRefusedError,
  WorkspaceHostUserNamespaces,
  WorkspaceReplaceRefusedError,
} from "@mend/sessions";
import { Store } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Clock, Deferred, Effect, Fiber, Layer, Queue, type Scope } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  claudeLine,
  peopleDir,
  PROJECT_DIR,
  writeUnder,
} from "./engine-person-runtime-fixtures.ts";
import {
  configuredHarnessHomePath,
  headFlush,
  headReport,
  shipCapturedHarnessHome,
} from "./engine/capture-fixture.ts";
import { signalled } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  captureAnswer,
  now,
  sealantLaunchLayer,
  setup,
  type World,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  isPrepare,
  personPlatform,
} from "./engine/person-fixture.ts";

const isRetireCheck = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("mend-retire");

/** What the change's owner is shown, and its fingerprint. */
const shownTo = (engine: SessionEngine["Service"], session: Session, viewer = "user-fixture") =>
  engine
    .workspaceRetirement(session.id, viewer)
    .pipe(
      Effect.flatMap((retirement) =>
        retirement === null ? Effect.die("no retirement") : Effect.succeed(retirement),
      ),
    );

describe("pre-release executors and the migration of their shared home (docs/adr/0016, Delivery 19)", () => {
  const IMAGE_KEY = "digest:sha256:img\u0000docker";

  /** A protocol host whose agents say they are quiescent, or have a turn in flight. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const quiescentHost = (busy: () => boolean) =>
    Layer.succeed(ProtocolHost, {
      attach: () => Effect.void,
      rehydrate: () => Effect.void,
      submitTurn: (sessionId, input, author) =>
        Effect.succeed(
          new AgentTurn({
            id: AgentTurnId.make(`turn-${crypto.randomUUID()}`),
            sessionId,
            processId: SessionProcessId.make("process"),
            ordinal: 0,
            author,
            input,
            status: "queued",
            providerTurnId: null,
            error: null,
            usage: null,
            createdAt: now(),
            startedAt: null,
            endedAt: null,
          }),
        ),
      sendMessage: () => Effect.die("message send not in this test"),
      steerTurn: () => Effect.die("not in test"),
      interruptTurn: () => Effect.void,
      respondRequest: () => Effect.die("not in test"),
      detach: () => Effect.void,
      has: () => Effect.succeed(true),
      quiescence: () =>
        Effect.sync(() => ({
          quiescent: !busy(),
          openTurn: busy(),
          work: [],
          settleMs: 0,
        })),
      awaitQuiescent: () => Effect.void,
      endWork: () => Effect.void,
      detachForHandOver: () => Effect.void,
    });

  /**
   * A worktree whose launch ran `shared` with the flag on (its image not yet known, so prepare
   * probed it and found it can run per person), on an image a per-person launch has confirmed
   * since: its next launch would be `person`. The first prepare answers the probe, every later
   * one makes the launcher.
   */
  type RetiringRun = (
    engine: SessionEngine["Service"],
    world: World,
    ids: { readonly session: Session; readonly order: ReadonlyArray<string> },
  ) => Effect.Effect<void, unknown, Store | WorktreesRepo | Scope.Scope | SessionEngine>;
  interface RetiringOptions {
    readonly busy?: () => boolean;
    readonly saved?: () => boolean;
    readonly retireCheck?: () => string;
    readonly state?: HarnessLayoutsMemoryState;
    /** Whether a per-person launch has confirmed the image since; yes unless a test says. */
    readonly confirmed?: boolean;
    /** Holds a PTY's open on the platform until it completes (a slow start). */
    readonly aroundOpen?: () => Effect.Effect<void>;
    /** Woken by every final flush the executor is asked for. */
    readonly flushed?: Queue.Queue<void>;
    /** Woken by every stop the platform is asked for. */
    readonly stopped?: Queue.Queue<void>;
    /** Holds each flush until it completes (an executor slow to answer). */
    readonly aroundFlush?: () => Effect.Effect<void>;
    /** What a launch's host preflight reads (`WorkspaceHostUserNamespaces`). */
    readonly hostUserNamespaces?: Layer.Layer<WorkspaceHostUserNamespaces>;
  }
  const retiringWorldEffect = (run: RetiringRun, options: RetiringOptions = {}) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const execCalls: Array<ReadonlyArray<string>> = [];
      const order: Array<string> = [];
      const scripts: Array<string> = [];
      const flushKinds: Array<CaptureFlushKind> = [];
      const memory = makeMemoryCaptureStore();
      const state = options.state ?? makeHarnessLayoutsMemoryState();
      let prepares = 0;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "auth",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launchProtocol(
              session.id,
              { mode: "protocol", prompt: "fix it", permissionMode: "bypass" },
              "user-fixture",
            );
            const launched = world.sessions.get(session.id);
            if (launched === undefined) return yield* Effect.die("no session");
            // A per-person launch elsewhere has since confirmed the image: a shared probe's yes
            // alone retires nothing (review of mend#582, finding 1).
            if (options.confirmed !== false) {
              for (const [key, record] of state.capabilities) {
                state.capabilities.set(key, { ...record, confirmed: true });
              }
            }
            yield* run(engine, world, { session: launched, order });
          }),
        {
          captured: memory,
          prepareWorld: (world) => world.members.set(MARIA, "member"),
          protocolHostLayer: quiescentHost(options.busy ?? (() => false)),
          ...(options.hostUserNamespaces === undefined
            ? {}
            : { hostUserNamespaces: options.hostUserNamespaces }),
          drainPolicy: { stallSeconds: 1 },
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
            execCalls,
            undefined,
            {
              flushKinds,
              ...(options.aroundOpen === undefined ? {} : { aroundOpen: options.aroundOpen }),
              // sealantd's record of each process: its pid, which the retire check counts as Mend's.
              timeline: (runId) => [
                {
                  sequence: 1n,
                  occurredAt: "2026-10-08T10:00:00Z",
                  summary: "started",
                  kind: "processStarted",
                  data: {
                    pid: 100 + Number(runId.replace(/\D/g, "") || "0"),
                    pgid: 100,
                    pidfd: true,
                    executable: "codex",
                    args: [],
                    cwd: "/workspace/repo",
                    startedAt: "0",
                  },
                },
              ],
              flush: (target) =>
                (options.aroundFlush?.() ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      order.push(`flush:${target.id}`);
                      if (options.flushed !== undefined)
                        Queue.offerUnsafe(options.flushed, undefined);
                      const saved = options.saved?.() ?? true;
                      return captureAnswer({
                        ...headReport(memory),
                        ...(saved ? {} : { pending: 3, pendingBytes: 1024 }),
                      });
                    }),
                  ),
                ),
              stopAnswer: () => {
                order.push("stop");
                if (options.stopped !== undefined) Queue.offerUnsafe(options.stopped, undefined);
                return "stopped";
              },
              exec: (argv) => {
                if (isRetireCheck(argv)) {
                  order.push("check");
                  scripts.push(argv[2] ?? "");
                  return {
                    exitCode: 0,
                    stdout: options.retireCheck?.() ?? "mend-retire checked\n",
                    stderr: "",
                  };
                }
                if (argv[0] === "sh" && isPrepare(argv)) {
                  prepares += 1;
                  return {
                    exitCode: 0,
                    stdout: prepares === 1 ? "mend-layout probed\n" : LAYOUT_READY,
                    stderr: "",
                  };
                }
                return undefined;
              },
            },
          ),
          harnessLayout: { flag: "person", state, platform: personPlatform([], { person: null }) },
        },
      );
      return { created, execCalls, order, flushKinds, state, scripts };
    });
  const retiringWorld = (run: RetiringRun, options: RetiringOptions = {}) =>
    Effect.runPromise(retiringWorldEffect(run, options));

  it(
    "replaces a shared executor on its own only after its final flush is saved, and the worktree's next launch runs per person",
    { timeout: 30_000 },
    async () => {
      const run = await retiringWorld((engine, world, { session }) =>
        Effect.gen(function* () {
          expect(world.sessions.get(session.id)?.sealantWorkspaceId).not.toBeNull();
          expect(yield* engine.workspaceRetirement(session.id, "user-fixture")).toBeNull();
          yield* engine.sweepRetirements();
        }),
      );
      expect(run.state.capabilities.get(IMAGE_KEY)?.person).toBe(true);
      // The check counted the agent's pid from its record (run-2, as the stand-in numbers it).
      expect(run.scripts[0]).toContain("for e in 102:0;");
      const check = run.order.indexOf("check");
      const flush = run.order.findIndex((entry) => entry.startsWith("flush:"));
      const stop = run.order.indexOf("stop");
      expect(check).toBeGreaterThanOrEqual(0);
      expect(flush).toBeGreaterThan(check);
      expect(stop).toBeGreaterThan(flush);
      expect(run.flushKinds).toContain("final");
      expect(run.created).toHaveLength(2);
      expect([...run.state.worktrees.values()].map((worktree) => worktree.layout)).toContain(
        "person",
      );
      expect([...run.state.retirements.values()]).toEqual([]);
    },
  );

  it.effect(
    "a launch while a pre-release replacement's pickup holds the gate is refused, and the pickup starts the one agent (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const open = yield* Deferred.make<void>();
        /** The pickup reached its agent's open, inside the launch gate, and is held there. */
        const opening = yield* Deferred.make<void>();
        let holding = false;
        let during = "";
        const run = yield* retiringWorldEffect(
          (engine, _world, { session }) =>
            Effect.gen(function* () {
              holding = true;
              const sweeping = yield* Effect.forkChild(engine.sweepRetirements());
              yield* Deferred.await(opening);
              const launched = yield* engine
                .launch(session.id, ["codex"], { over: Restart })
                .pipe(Effect.result);
              during = launched._tag === "Failure" ? launched.failure._tag : "launched";
              yield* Deferred.succeed(open, undefined);
              yield* Fiber.join(sweeping);
            }),
          {
            aroundOpen: () =>
              Effect.suspend(() => {
                if (!holding) return Effect.void;
                holding = false;
                return Deferred.succeed(opening, undefined).pipe(
                  Effect.andThen(Deferred.await(open)),
                );
              }),
          },
        );
        expect(during).toBe("SessionAgentLiveError");
        expect(run.created).toHaveLength(2);
        expect([...run.state.retirements.values()]).toEqual([]);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a pre-release replacement's pickup that a launch held off is kept as a plan, and resumes the agent once that launch starts nothing (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<HostUserNamespaces | null>();
        let holding = false;
        let planned: unknown = null;
        const seen = { holder: "", status: "", planLeft: true };
        const flushing = yield* Deferred.make<void>();
        const flushed = yield* Deferred.make<void>();
        let holdFlush = false;
        const run = yield* retiringWorldEffect(
          (engine, world, { session }) =>
            Effect.gen(function* () {
              holdFlush = true;
              const sweeping = yield* Effect.forkChild(engine.sweepRetirements());
              // Checked, and its final flush on its way: a launch admitted now holds the gate
              // when the replacement's pickup comes.
              yield* Deferred.await(flushing);
              holding = true;
              const launching = yield* engine
                .launch(session.id, ["codex"], { over: Restart })
                .pipe(Effect.result, Effect.forkChild);
              yield* Deferred.await(held);
              yield* Deferred.succeed(flushed, undefined);
              yield* Fiber.join(sweeping);
              const stored = world.relaunches.get(session.id);
              planned = stored === undefined ? null : JSON.parse(stored);
              yield* Deferred.succeed(answer, {
                allowed: false,
                setting: "kernel.unprivileged_userns_clone=1",
              });
              seen.holder = (yield* Fiber.join(launching))._tag;
              yield* engine.reapCaptureLeases();
              for (let step = 0; step < 100 && world.relaunches.has(session.id); step += 1) {
                yield* TestClock.adjust("100 millis");
                yield* Effect.yieldNow;
              }
              seen.status = world.sessions.get(session.id)?.status ?? "";
              seen.planLeft = world.relaunches.has(session.id);
            }),
          {
            aroundFlush: () =>
              Effect.suspend(() => {
                if (!holdFlush) return Effect.void;
                holdFlush = false;
                return Deferred.succeed(flushing, undefined).pipe(
                  Effect.andThen(Deferred.await(flushed)),
                );
              }),
            hostUserNamespaces: Layer.succeed(WorkspaceHostUserNamespaces, {
              observe: () =>
                Effect.suspend(() => {
                  if (!holding) return Effect.succeed(null);
                  holding = false;
                  return Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(Deferred.await(answer)),
                  );
                }),
            }),
          },
        );
        expect(planned).toMatchObject({ kind: "pickup", harness: "codex" });
        expect(seen).toMatchObject({ holder: "Failure", status: "running", planLeft: false });
        expect(run.created).toHaveLength(2);
        expect([...run.state.retirements.values()]).toEqual([]);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "the owner's Stop during a pre-release replacement's final flush wins: the replacement ends the executor, and no pickup starts the agent again (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const flushing = yield* Deferred.make<void>();
        const flushed = yield* Deferred.make<void>();
        let holdFlush = false;
        const seen = { stop: "", status: "", live: 0 };
        const run = yield* retiringWorldEffect(
          (engine, world, { session }) =>
            Effect.gen(function* () {
              holdFlush = true;
              const sweeping = yield* Effect.forkChild(engine.sweepRetirements());
              yield* Deferred.await(flushing);
              seen.stop = (yield* engine.stop(session.id).pipe(Effect.result))._tag;
              yield* Deferred.succeed(flushed, undefined);
              yield* Fiber.join(sweeping);
              for (let step = 0; step < 20; step += 1) {
                yield* TestClock.adjust("100 millis");
                yield* Effect.yieldNow;
              }
              seen.status = world.sessions.get(session.id)?.status ?? "";
              seen.live = [...world.processes.values()].filter(
                (process) =>
                  process.sessionId === session.id &&
                  process.kind === "agent-protocol" &&
                  process.exitedAt === null,
              ).length;
            }),
          {
            aroundFlush: () =>
              Effect.suspend(() => {
                if (!holdFlush) return Effect.void;
                holdFlush = false;
                return Deferred.succeed(flushing, undefined).pipe(
                  Effect.andThen(Deferred.await(flushed)),
                );
              }),
          },
        );
        expect(seen).toEqual({ stop: "Success", status: "stopped", live: 0 });
        expect(run.created).toHaveLength(1);
      }),
    { timeout: 30_000 },
  );

  it(
    "retires nothing on a shared probe's yes alone: only an answer a per-person executor gave replaces a live executor (review of mend#582, finding 1)",
    { timeout: 30_000 },
    async () => {
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            expect(yield* engine.workspaceRetirement(session.id, "user-fixture")).toBeNull();
          }),
        { confirmed: false },
      );
      expect(run.state.capabilities.get(IMAGE_KEY)).toMatchObject({
        person: true,
        confirmed: false,
      });
      expect(run.order).not.toContain("check");
      expect(run.order).not.toContain("stop");
      expect(run.created).toHaveLength(1);
      expect([...run.state.retirements.values()]).toEqual([]);
    },
  );

  it(
    "says a steered turn spends the owner's logins in a shared executor with the flag on, and runs on its sender's once the executor is per person (review of mend#576, P1-2)",
    { timeout: 30_000 },
    async () => {
      const answers: Array<boolean> = [];
      await retiringWorld((engine, world, { session }) =>
        Effect.gen(function* () {
          answers.push(yield* engine.steersPerPerson(session));
          yield* engine.sweepRetirements();
          const relaunched = world.sessions.get(session.id);
          if (relaunched === undefined) return yield* Effect.die("no session");
          answers.push(yield* engine.steersPerPerson(relaunched));
        }),
      );
      expect(answers).toEqual([false, true]);
    },
  );

  it.effect(
    "keeps the executor when its final flush is not saved, and says why: nothing is lost",
    () =>
      Effect.gen(function* () {
        let shown: { readonly state: string; readonly reason: string | null } | null = null;
        const flushed = yield* Queue.make<void>();
        const run = yield* retiringWorldEffect(
          (engine, _world, { session }) =>
            Effect.gen(function* () {
              const sweeping = yield* Effect.forkChild(engine.sweepRetirements());
              // Its final flush answers pending and nothing moves: the drain looks every
              // `pollInterval` (10 ms) until the stall window (`stallSeconds`, 1 s) is out.
              yield* Queue.take(flushed);
              for (let look = 1; look < 100; look++) yield* TestClock.adjust(10);
              expect(sweeping.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(10);
              yield* Fiber.join(sweeping);
              const retirement = yield* shownTo(engine, session);
              shown = { state: retirement.state, reason: retirement.reason };
            }),
          { saved: () => false, flushed },
        );
        expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
        expect(run.created).toHaveLength(1);
        // Its final flush was sent: it stays `retiring` while its drain asks again, as it would
        // after a restart, and says why (review 2 of mend#575).
        expect(shown).toEqual({
          state: "retiring",
          reason: "not replaced yet · the final flush was not saved (kept)",
        });
      }),
    { timeout: 30_000 },
  );

  it(
    "never replaces on its own an executor with a hand-started Service, and refuses others' joins, turns and follow-ups until it is replaced",
    { timeout: 30_000 },
    async () => {
      const run_state = makeHarnessLayoutsMemoryState();
      let seen: WorkspaceRetirement | null = null;
      let asMaria: WorkspaceRetirement | null = null;
      let joinRefusal = "";
      let turnRefusal = "";
      let followUpRefusal = "";
      let ownTurn: string | null = null;
      const run = await retiringWorld(
        (engine, world, { session }) =>
          Effect.gen(function* () {
            yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
            // The executor started before this release: no layout recorded for its launch.
            const launch = world.executorLaunches.get(session.id)?.launchId;
            if (launch !== undefined) run_state.launches.delete(launch);
            yield* engine.sweepRetirements();
            seen = yield* shownTo(engine, session);
            asMaria = yield* shownTo(engine, session, MARIA);
            const joined = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            joinRefusal = yield* engine.launch(joined.id, ["claude"]).pipe(
              Effect.flip,
              Effect.map((error) => (error instanceof SealantPlatformError ? error.message : "")),
            );
            turnRefusal = yield* engine.submitTurn(session.id, "hello", MARIA).pipe(
              Effect.flip,
              Effect.map((error) =>
                error instanceof SessionTurnRefusedError ? error.message : "",
              ),
            );
            // A reviewer's follow-up is a turn too (review of mend#575, P2-1).
            followUpRefusal = yield* engine
              .launchFollowUp(session.id, "address the comments", "follow-up-1", MARIA)
              .pipe(
                Effect.flip,
                Effect.map((error) => (error instanceof SealantPlatformError ? error.message : "")),
              );
            ownTurn = (yield* engine.submitTurn(session.id, "go on", "user-fixture")).input;
            expect(world.sessions.get(joined.id)?.status).toBe("failed");
          }),
        { state: run_state },
      );
      expect(seen).toMatchObject({
        state: "marked",
        preRelease: true,
        launcher: "user-fixture",
        stops: [{ kind: "service", label: "auth · web" }],
        canReplace: true,
      });
      expect(seen).not.toMatchObject({ checkedAt: null });
      // Checked, never flushed for good, never stopped.
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
      expect(run.flushKinds).not.toContain("final");
      expect(asMaria).toMatchObject({ canReplace: false });
      expect(joinRefusal).toBe(
        "This worktree's workspace started before Mend 0.36 and shares one home; it takes another person once it is replaced.",
      );
      expect(turnRefusal).toBe(joinRefusal);
      expect(followUpRefusal).toBe(joinRefusal);
      expect(ownTurn).toBe("go on");
    },
  );

  it(
    "lists what runs in it that Mend did not start, and its containers, by name to the owner only; replaces on its own once they have gone",
    { timeout: 30_000 },
    async () => {
      let answer =
        "mend-retire process 31 python\nmend-retire container pg (postgres:17)\nmend-retire checked\n";
      let first: WorkspaceRetirement | null = null;
      let other: WorkspaceRetirement | null = null;
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            first = yield* shownTo(engine, session);
            other = yield* shownTo(engine, session, MARIA);
            answer = "mend-retire checked\n";
            yield* engine.sweepRetirements();
          }),
        { retireCheck: () => answer },
      );
      expect(first).toMatchObject({
        state: "marked",
        stops: [
          { kind: "process", label: "python (pid 31)" },
          { kind: "container", label: "pg (postgres:17)" },
        ],
        reason: "not replaced · 1 process Mend did not start, 1 running container",
      });
      // Anyone else who sees the session sees what kind of thing would stop, not its name.
      expect(other).toMatchObject({
        stops: [
          { kind: "process", label: "" },
          { kind: "container", label: "" },
        ],
      });
      expect(run.order.at(-1)).toBe("stop");
    },
  );

  it.effect(
    "sees a start the launcher began before the check: it would stop, so nothing is replaced (review 2 of mend#575, P2-B)",
    () =>
      Effect.gen(function* () {
        const open = yield* Deferred.make<void>();
        /** The second's start reached its PTY open, and is held there. */
        const opening = yield* Deferred.make<void>();
        let holding = false;
        let shown: ReadonlyArray<string> = [];
        const run = yield* retiringWorldEffect(
          (engine, _world, { session }) =>
            Effect.gen(function* () {
              // The launcher's second session joins the executor; its start is under way.
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: "second",
                ownerUserId: "user-fixture",
              });
              holding = true;
              const starting = yield* Effect.forkChild(engine.launch(second.id, ["claude"]));
              yield* Deferred.await(opening);
              yield* engine.sweepRetirements();
              shown = (yield* shownTo(engine, session)).stops.map((stop) => stop.label);
              yield* Deferred.succeed(open, undefined);
              yield* Fiber.join(starting).pipe(Effect.ignore);
            }),
          {
            aroundOpen: () =>
              holding
                ? Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(open)))
                : Effect.void,
          },
        );
        expect(shown).toContain("second · a start under way");
        expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
        expect(run.flushKinds).not.toContain("final");
      }),
    { timeout: 30_000 },
  );

  it(
    "holds an automatic replacement when the containers cannot be checked, and says why",
    { timeout: 30_000 },
    async () => {
      let shown: WorkspaceRetirement | null = null;
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            shown = yield* shownTo(engine, session);
          }),
        {
          retireCheck: () =>
            "mend-retire unknown running containers: docker ps failed (Cannot connect to the Docker daemon)\nmend-retire checked\n",
        },
      );
      expect(shown).toMatchObject({
        stops: [
          {
            kind: "unchecked",
            label: "running containers: docker ps failed (Cannot connect to the Docker daemon)",
          },
        ],
        reason: "not replaced · 1 thing Mend could not check",
      });
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
    },
  );

  it.effect(
    "lets only the change's owner replace it now, never with a turn in flight, and never ending more than they were shown",
    () =>
      Effect.gen(function* () {
        let busy = false;
        let answer = "mend-retire checked\n";
        const refusals: Array<string> = [];
        const stopped = yield* Queue.make<void>();
        const run = yield* retiringWorldEffect(
          (engine, _world, { session, order }) =>
            Effect.gen(function* () {
              yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
              yield* engine.sweepRetirements();
              const refused = (actor: string, seen: string) =>
                engine.replaceWorkspaceNow(session.id, actor, seen).pipe(
                  Effect.flip,
                  Effect.map((error) =>
                    error instanceof WorkspaceReplaceRefusedError ? error.message : "",
                  ),
                );
              const shown = yield* shownTo(engine, session);
              refusals.push(yield* refused(MARIA, shown.fingerprint));
              // A turn starts after the owner looked.
              busy = true;
              refusals.push(yield* refused("user-fixture", shown.fingerprint));
              busy = false;
              // A detached job starts after the owner looked: nothing they were not shown ends.
              yield* engine.sweepRetirements();
              const again = yield* shownTo(engine, session);
              answer = "mend-retire process 40 node\nmend-retire checked\n";
              refusals.push(yield* refused("user-fixture", again.fingerprint));
              expect(order.includes("stop")).toBe(false);
              // Shown it, the owner replaces it.
              yield* engine.sweepRetirements();
              const latest = yield* shownTo(engine, session);
              expect(latest.stops.map((stop) => stop.kind)).toEqual(["service", "process"]);
              yield* engine.replaceWorkspaceNow(session.id, "user-fixture", latest.fingerprint);
              yield* signalled(stopped)(() => order.includes("stop"), "the replacement");
            }),
          { busy: () => busy, retireCheck: () => answer, stopped },
        );
        expect(refusals).toEqual([
          "Only the change's owner replaces this worktree's workspace.",
          "An agent's turn or background work is in flight in this workspace. Replace it once that has finished.",
          "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.",
        ]);
        // The owner's replacement checked what runs in it again, and waited for a saved flush.
        const lastCheck = run.order.lastIndexOf("check");
        expect(lastCheck).toBeLessThan(run.order.indexOf("stop"));
        expect(run.flushKinds).toContain("final");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "takes a replacement a crash left retiring back to marked: on the sweep once stale, and when the owner asks again",
    () =>
      Effect.gen(function* () {
        const run_state = makeHarnessLayoutsMemoryState();
        let afterSweep: string | null = null;
        let ownTurn: string | null = null;
        const stopped = yield* Queue.make<void>();
        const run = yield* retiringWorldEffect(
          (engine, _world, { session, order }) =>
            Effect.gen(function* () {
              yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
              yield* engine.sweepRetirements();
              const workspaceId = session.sealantWorkspaceId ?? "";
              // Stamped on the engine's clock, which the sweep's staleness reads.
              const crashed = (minutesAgo: number) =>
                Effect.map(Clock.currentTimeMillis, (nowMs) => {
                  const row = run_state.retirements.get(workspaceId);
                  if (row === undefined) throw new Error("not marked");
                  run_state.retirements.set(workspaceId, {
                    ...row,
                    state: "retiring",
                    updatedAt: new Date(nowMs - minutesAgo * 60_000),
                  });
                });
              // A fresh one is left alone: a replacement in another process may still run it.
              yield* crashed(1);
              yield* engine.sweepRetirements();
              expect(run_state.retirements.get(workspaceId)?.state).toBe("retiring");
              // Stale: back to marked, with why, and the launcher's turns go ahead again.
              yield* crashed(11);
              yield* engine.sweepRetirements();
              afterSweep = run_state.retirements.get(workspaceId)?.reason ?? null;
              ownTurn = (yield* engine.submitTurn(session.id, "go on", "user-fixture")).input;
              // A restart in the middle (nothing here moves it): the owner's ask takes it back first
              // and goes ahead, never answering ok while doing nothing.
              yield* crashed(1);
              const shown = yield* shownTo(engine, session);
              yield* engine.replaceWorkspaceNow(session.id, "user-fixture", shown.fingerprint);
              yield* signalled(stopped)(() => order.includes("stop"), "the replacement");
            }),
          { state: run_state, stopped },
        );
        expect(afterSweep).toBe("not replaced · the replacement did not finish; looked at again");
        expect(ownTurn).toBe("go on");
        expect(run.flushKinds).toContain("final");
      }),
    { timeout: 30_000 },
  );
});

describe("the migration of an old shared home's memory (docs/adr/0016, Delivery 19)", () => {
  const MEMORY = `${PROJECT_DIR}/memory/MEMORY.md`;
  const NOTES = ".codex/memories/notes.md";

  /**
   * A worktree whose last executor ran `shared`: its home's memory written in two captures, the
   * migration run once between them (provisional) and twice after the worktree turned person.
   */
  const migrateAcrossTheTurn = async (options: {
    readonly maria: boolean;
    /** Maria is a member of the organization; true unless said. */
    readonly mariaMember?: boolean;
    /** The owner record holds every session, deleted ones included; true unless said. */
    readonly complete?: boolean;
    /** Whose memory the home holds as the server recorded it, left in place of nothing. */
    readonly homes?: (worktreeId: string) => AgentMemoryHomes;
  }) => {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const memory = makeMemoryCaptureStore();
    const state = makeHarnessLayoutsMemoryState();
    const homes = new Map<string, AgentMemoryHomes>();
    const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
    const records: Array<PreReleaseMigrationRecord | null> = [];
    const chainBefore: Array<number> = [];
    const chainAfter: Array<number> = [];
    let execsBefore = 0;
    let execsAfter = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "before",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["claude"]);
          // Who ever had a session in the worktree, as the durable record keeps it.
          state.sessionOwners.set(session.worktreeId, {
            owners: options.maria ? ["user-fixture", MARIA] : ["user-fixture"],
            complete: options.complete ?? true,
          });
          if (options.maria) {
            // Maria joined the shared home before 0.36: whose lines are whose cannot be told.
            const joined = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            yield* engine.launch(joined.id, ["claude"]);
          }
          const request = created[0];
          if (request === undefined) return yield* Effect.die("the launch made no executor");
          const executorRoot = path.join(tmp, "shared-executor");
          const home = configuredHarnessHomePath(request, executorRoot);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          writeUnder(home, MEMORY, "- first\n");
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          // No record of whose memory the home holds: the sessions decide (unless a test says).
          const recorded = () => {
            homes.clear();
            if (options.homes !== undefined) {
              homes.set(session.worktreeId, options.homes(session.worktreeId));
            }
          };
          recorded();
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          // The shared executor goes on writing after the provisional run.
          writeUnder(home, MEMORY, "- first\n- second\n");
          writeUnder(home, NOTES, "codex learned\n");
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          recorded();
          // Its final flush was the last shared-layout capture: the worktree runs per person now.
          state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
          const chain = memory.chains.get(session.worktreeId);
          chainBefore.push(chain?.headN ?? -1);
          execsBefore = execCalls.length;
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          execsAfter = execCalls
            .slice(execsBefore)
            .filter((argv) => argv.join(" ").includes("memor")).length;
          chainAfter.push(memory.chains.get(session.worktreeId)?.headN ?? -1);
        }),
      {
        captured: memory,
        prepareWorld: (world) => {
          if (options.mariaMember === false) world.members.delete(MARIA);
          else world.members.set(MARIA, "member");
        },
        agentMemoryLayer: agentMemoryLayerOf(
          {
            readBack: (input) =>
              Effect.sync(() => {
                if (input.sessionId.startsWith("pre-release:")) readBacks.push(input);
                return {
                  saved: input.session.map((file) => file.path),
                  merged: [],
                  deleted: [],
                  skipped: [],
                };
              }),
          },
          homes,
        ),
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
          execCalls,
          undefined,
          { flush: headFlush(memory) },
        ),
        harnessLayout: { flag: "shared", state },
      },
    );
    return { readBacks, records, chainBefore, chainAfter, execsBefore, execsAfter };
  };

  it(
    "credits what a shared executor wrote after a provisional run once the worktree turns person, and a re-run credits nothing twice",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false });
      const [provisional, final, again] = run.records;
      expect(provisional).toMatchObject({
        final: false,
        captureN: 1,
        creditedTo: "user-fixture",
        decidedBy: "only-person",
        notCredited: [],
      });
      expect(final).toMatchObject({ final: true, captureN: 2, creditedTo: "user-fixture" });
      expect(again).toEqual(final);
      // The provisional run credited the first line; the final run only what came after it,
      // read back against what the first run credited.
      expect(run.readBacks.map((input) => input.userId)).toEqual(["user-fixture", "user-fixture"]);
      expect(run.readBacks[0]?.session.map((file) => [file.path, file.contents])).toEqual([
        [MEMORY, "- first\n"],
      ]);
      expect(
        run.readBacks[1]?.session
          .map((file) => [file.path, file.contents])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual(
        [
          [NOTES, "codex learned\n"],
          [MEMORY, "- first\n- second\n"],
        ].toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      );
      expect(Object.keys(run.readBacks[1]?.delivered ?? {})).toEqual([MEMORY]);
      // It reads a capture and records: no exec touches memory, nothing added to the chain.
      expect(run.execsAfter).toBe(0);
      expect(run.chainAfter).toEqual(run.chainBefore);
    },
  );

  it(
    "credits nobody memory two people's sessions shared, and lists it on the worktree as not credited",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: true });
      expect(run.readBacks).toEqual([]);
      expect(run.records[1]).toMatchObject({
        final: true,
        creditedTo: null,
        decidedBy: "nobody",
        notCredited: [NOTES, MEMORY].toSorted(),
      });
    },
  );

  it(
    "credits nobody while a hand-over is pending, or when the home's record names another executor",
    { timeout: 30_000 },
    async () => {
      const pending = await migrateAcrossTheTurn({
        maria: false,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "workspace-1" },
          pending: {
            userId: MARIA,
            sessionId: null,
            workspaceId: "workspace-2",
            epoch: 9,
            n: null,
          },
        }),
      });
      expect(pending.readBacks).toEqual([]);
      expect(pending.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
      const elsewhere = await migrateAcrossTheTurn({
        maria: false,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "an-older-executor" },
          pending: null,
        }),
      });
      expect(elsewhere.readBacks).toEqual([]);
      expect(elsewhere.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
    },
  );

  it(
    "credits the person a settled record names for the executor that wrote the capture",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({
        maria: true,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "workspace-1" },
          pending: null,
        }),
      });
      expect(run.records[1]).toMatchObject({
        creditedTo: "user-fixture",
        decidedBy: "home-record",
      });
      expect(run.readBacks.map((input) => input.userId)).toEqual(["user-fixture", "user-fixture"]);
    },
  );

  it(
    "credits nobody by the only-person rule where sessions deleted before the owner record cannot be known",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false, complete: false });
      expect(run.readBacks).toEqual([]);
      expect(run.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
    },
  );

  it(
    "credits the only member of an organization that never had a second one, on a worktree older than the owner record (owner decision 2026-10-08)",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false, complete: false, mariaMember: false });
      expect(run.records[1]).toMatchObject({
        creditedTo: "user-fixture",
        decidedBy: "only-person",
      });
    },
  );

  it.effect(
    "runs off the launch path: a person launch never waits for the migration it starts",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        /** The migration read its record, and ran to its end. */
        const entered = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        let launched = false;
        const memory = makeMemoryCaptureStore();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "fresh",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              launched = true;
              // The launch ran per person and returned; the migration it started is still waiting.
              yield* Deferred.await(entered);
              expect(yield* Deferred.isDone(finished)).toBe(false);
              yield* Deferred.succeed(release, undefined);
              yield* Deferred.await(finished);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
            ),
            harnessLayout: {
              flag: "person",
              platform: personPlatform([], { person: true }),
              wrapRepo: (inner) => ({
                ...inner,
                preReleaseMigrationOf: (worktreeId) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(inner.preReleaseMigrationOf(worktreeId)),
                    Effect.ensuring(Deferred.succeed(finished, undefined)),
                  ),
              }),
            },
          },
        );
        expect(launched).toBe(true);
      }),
    { timeout: 30_000 },
  );
});

/** A session's observed agents (`agent-external` rows). */
const externalRowsOf = (world: World, sessionId: SessionId) =>
  [...world.processes.values()].filter(
    (process) => process.kind === "agent-external" && process.sessionId === sessionId,
  );

describe("agents run by hand are observed in the head capture (docs/adr/0016)", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const personLayers = (
    created: Array<CreateOptions>,
    memory: MemoryCaptureStore,
    state?: HarnessLayoutsMemoryState,
  ) => ({
    captured: memory,
    prepareWorld: (world: World) => world.members.set(MARIA, "member"),
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
      [],
      undefined,
      { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
    ),
    harnessLayout: {
      flag: "person" as const,
      platform: personPlatform([], { person: true }),
      ...(state === undefined ? {} : { state }),
    },
  });

  /** A person executor with one workbench session of `user-fixture`'s, a shell holding it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const workbenchIn = (
    world: World,
    tmp: string,
    created: Array<CreateOptions>,
    memory: MemoryCaptureStore,
  ) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const engine = yield* SessionEngine;
      const session = yield* engine.provision({
        projectId: project.id,
        harness: "claude",
        label: null,
        name: "workbench",
        ownerUserId: "user-fixture",
        start: { kind: "base", base: null },
      });
      yield* engine.launch(session.id, ["bash"]);
      const request = created[0];
      if (request === undefined) return yield* Effect.die("the launch made no executor");
      const executorRoot = path.join(tmp, "person-executor");
      const home = configuredHarnessHomePath(request, executorRoot);
      const ship = shipCapturedHarnessHome(
        tmp,
        memory,
        session.worktreeId,
        memory.leases.get(session.worktreeId)?.epoch ?? 0,
        request,
        executorRoot,
      );
      return { engine, session, home, ship };
    });

  it(
    "an observed agent in a shared conversation's session is harvested from its own saved directory, not the shared conversation",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const state = makeHarnessLayoutsMemoryState();
      const byHand = crypto.randomUUID();
      const shared = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            // Shared control moved the session's conversation into `C`: its engine conversation,
            // with other people's turns, is there and newer than anything else.
            state.sharedConversations.set(session.id, {
              owner: "user-fixture",
              movedAt: new Date(),
            });
            const handTranscript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${byHand}.jsonl`;
            writeUnder(home, handTranscript, claudeLine(byHand, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.providerSessionId)).toEqual([
              byHand,
            ]);

            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, handTranscript), past, past);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/conversations/${session.id}/${PROJECT_DIR}/${shared}.jsonl`,
              claudeLine(shared, "the shared conversation"),
            );
            yield* ship;
            yield* engine.observeExternalAgents();
            const [row] = externalRowsOf(world, session.id);
            expect(row?.exitedAt).not.toBeNull();
            // The harvest recorded her own conversation, never the shared one.
            expect(row?.providerSessionId).toBe(byHand);
            expect(world.sessions.get(session.id)?.providerSessionId).toBe(byHand);
          }),
        personLayers(created, memory, state),
      );
    },
  );

  it(
    "a head that cannot be read keeps an observed agent as it is, and the next readable head ends it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            const transcript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`;
            writeUnder(home, transcript, claudeLine(id, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.exitedAt)).toEqual([null]);

            // The writes went quiet, but the head that says so cannot be read this pass.
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, transcript), past, past);
            const unreadable = yield* ship;
            const manifest = path.join(tmp, "blobs", unreadable.key);
            const bytes = fs.readFileSync(manifest);
            fs.rmSync(manifest);
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.exitedAt)).toEqual([null]);

            fs.writeFileSync(manifest, bytes);
            yield* engine.observeExternalAgents();
            const rows = externalRowsOf(world, session.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.exitedAt).not.toBeNull();
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a fresh write from before the session began is history; one within the clock skew of its start is not",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const before = crypto.randomUUID();
      const atStart = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            const began = session.createdAt.getTime();
            // A minute before the session: fresh, and still not this session's.
            const claude = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${before}.jsonl`;
            writeUnder(home, claude, claudeLine(before, "another session's"));
            fs.utimesSync(
              path.join(home, claude),
              new Date(began - 60_000),
              new Date(began - 60_000),
            );
            // A second before it, within the skew between the executor's clock and Mend's.
            const codex = `${peopleDir("user-fixture")}/.codex/sessions/2026/10/11/rollout-2026-10-11T10-00-00-${atStart}.jsonl`;
            writeUnder(home, codex, "{}\n");
            fs.utimesSync(path.join(home, codex), new Date(began - 1_000), new Date(began - 1_000));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(
              externalRowsOf(world, session.id).map((row) => [row.harness, row.providerSessionId]),
            ).toEqual([["codex", atStart]]);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a claude a person runs by hand writes into their saved directory and is observed as theirs",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      const old = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            // The open workbench: a shell holds the workspace; no engine agent runs.
            yield* engine.launch(session.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            // A conversation of hers from before this session, in the same saved directory: history,
            // never an agent of this session's.
            const before = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${old}.jsonl`;
            writeUnder(home, before, claudeLine(old, "an earlier session"));
            const earlier = new Date(session.createdAt.getTime() - 60 * 60_000);
            fs.utimesSync(path.join(home, before), earlier, earlier);
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)).toHaveLength(0);

            // Her `claude` in the terminal writes through her home's link into her saved directory.
            const transcript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`;
            writeUnder(home, transcript, claudeLine(id, "by hand"));
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            const observed = externalRowsOf(world, session.id);
            expect(observed).toHaveLength(1);
            expect(observed[0]?.harness).toBe("claude");
            expect(observed[0]?.providerSessionId).toBe(id);
            expect(observed[0]?.runsAs).toBe("user-fixture");
            expect(observed[0]?.exitedAt).toBeNull();
            expect(world.sessions.get(session.id)?.status).toBe("running");

            // A second pass over the same head observes nothing new.
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)).toHaveLength(1);

            // The writes go quiet: the next capture carries the old mtime, and the end is recorded.
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, transcript), past, past);
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)[0]?.exitedAt).not.toBeNull();
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "two people's agents in one executor are each observed in their own session, never the other's",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const alice = crypto.randomUUID();
      const maria = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(holder.id, ["bash"]);
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            yield* engine.launch(joined.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${alice}.jsonl`,
              claudeLine(alice, "alice by hand"),
            );
            writeUnder(
              home,
              `${peopleDir(MARIA)}/${PROJECT_DIR}/${maria}.jsonl`,
              claudeLine(maria, "maria by hand"),
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              holder.worktreeId,
              memory.leases.get(holder.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();

            const alices = externalRowsOf(world, holder.id);
            expect(alices.map((row) => [row.providerSessionId, row.runsAs])).toEqual([
              [alice, "user-fixture"],
            ]);
            const marias = externalRowsOf(world, joined.id);
            expect(marias.map((row) => [row.providerSessionId, row.runsAs])).toEqual([
              [maria, MARIA],
            ]);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a sibling session's engine agent writing into the same saved directory is not read as run by hand",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const agent = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "agent",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(agent.id, ["claude"]);
            const workbench = yield* engine.provisionSessionIn(agent.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(workbench.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            // Mend's own claude writes into her saved directory, which the workbench reads too.
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`,
              claudeLine(id, "mend's agent"),
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              agent.worktreeId,
              memory.leases.get(agent.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(
              [...world.processes.values()].filter((row) => row.kind === "agent-external"),
            ).toHaveLength(0);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "an observed agent keeps its own conversation while a sibling's engine agent writes beside it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const byHand = crypto.randomUUID();
      const mends = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const workbench = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(workbench.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            const epoch = memory.leases.get(workbench.worktreeId)?.epoch ?? 0;
            const ship = shipCapturedHarnessHome(
              tmp,
              memory,
              workbench.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            const handTranscript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${byHand}.jsonl`;
            writeUnder(home, handTranscript, claudeLine(byHand, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, workbench.id).map((row) => row.providerSessionId)).toEqual(
              [byHand],
            );

            // Then she starts an agent from Mend in a second session of the worktree; it writes
            // into the same saved directory, newer than her own conversation, which goes quiet.
            const agent = yield* engine.provisionSessionIn(workbench.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(agent.id, ["claude"]);
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, handTranscript), past, past);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${mends}.jsonl`,
              claudeLine(mends, "mend's agent"),
            );
            yield* ship;
            yield* engine.observeExternalAgents();
            const rows = externalRowsOf(world, workbench.id);
            expect(rows.map((row) => row.providerSessionId)).toEqual([byHand]);
            expect(rows[0]?.exitedAt).not.toBeNull();
            expect(externalRowsOf(world, agent.id)).toHaveLength(0);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a shared executor's agent run by hand is observed from the head capture",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(session.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "shared-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            writeUnder(
              home,
              `.codex/sessions/2026/10/11/rollout-2026-10-11T10-00-00-${id}.jsonl`,
              "{}\n",
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            const observed = externalRowsOf(world, session.id);
            expect(observed.map((row) => [row.harness, row.providerSessionId, row.runsAs])).toEqual(
              [["codex", id, null]],
            );
          }),
        {
          captured: memory,
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
            [],
            undefined,
            { flush: headFlush(memory) },
          ),
        },
      );
    },
  );
});
