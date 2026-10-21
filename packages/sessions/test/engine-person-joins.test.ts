import { WorktreesRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Project, Session, SessionProcess } from "@mend/domain/workbench";
import {
  asSealantUser,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
} from "@mend/sealant";
import {
  type CaptureHold,
  STOPPED_LOST_SIGHT,
  STOPPED_NOT_MEMBER,
  EXECUTOR_RETIRED,
  SessionEngine,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
} from "@mend/sessions";
import { Store } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, InteractiveSessionStatus } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, Logger, Queue, type Scope } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { provisionIn } from "./engine/capture-fixture.ts";
import { signalled, signalledFixture, watched } from "./engine/clock-fixture.ts";
import {
  now,
  sealantLaunchLayer,
  setup,
  setupSibling,
  type World,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import { MARIA, workspacesPerOwner } from "./engine/person-fixture.ts";

/** What a test after a join by another person is handed. */
interface JoinByAnother {
  readonly holder: SessionId;
  readonly joined: SessionId;
  readonly tmp: string;
  readonly project: Project;
  /** The platform client exactly as the engine and the routes reach it. */
  readonly platform: SealantClientShape;
  /** Every judged call (`workspacesPerOwner`), in order. */
  readonly calls: Array<string>;
  readonly execCalls: Array<ReadonlyArray<string>>;
  /** Every PTY the platform closed. */
  readonly closed: Set<string>;
  /** Every workspace the platform was asked to stop. */
  readonly stopped: Array<string>;
  readonly memory: MemoryCaptureStore;
  /** Every engine log line, in order. */
  readonly logs: ReadonlyArray<string>;
  /** Waits for `condition`, woken by every engine log line, workspace exec and workspace stop. */
  readonly untilChanged: (condition: () => boolean, label: string) => Effect.Effect<void>;
  /** Arm the actual post-harvest lease decision, not a predicate over its desired outcome. */
  readonly armTail: (
    phase: "agent" | "sweep",
    decisions?: number,
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly nextRefusedClose: () => Effect.Effect<Deferred.Deferred<void>>;
}

/** The platform's refused PTY closes, each awaitable before it happens (`nextRefusedClose`). */
const refusedCloses = (refuses: () => boolean) => {
  let count = 0;
  const ready = new Map<number, Deferred.Deferred<void>>();
  return {
    closeFails: () => {
      const refused = refuses();
      if (refused) {
        count += 1;
        const next = ready.get(count);
        if (next !== undefined) Deferred.doneUnsafe(next, Effect.void);
      }
      return refused;
    },
    nextRefusedClose: () =>
      Effect.map(Deferred.make<void>(), (next) => {
        ready.set(count + 1, next);
        return next;
      }),
  };
};

/**
 * The owner's session runs; Maria, a member, starts one in its worktree and launches it, on a
 * platform where every call about the owner's workspace by anyone but the owner is a 404.
 */
const joinByAnotherPersonEffect = (
  then: (
    engine: SessionEngine["Service"],
    world: World,
    join: JoinByAnother,
  ) => Effect.Effect<void, unknown, SessionEngine | Store | WorktreesRepo | Scope.Scope>,
  options: {
    readonly closeFails?: () => boolean;
    readonly getSessionDefect?: (ptyId: string) => boolean;
    /** A case's own git origin and adoption, run over the store before the engine exists. */
    readonly prepare?: (
      world: World,
      tmp: string,
      project: Project,
    ) => Effect.Effect<unknown, unknown, Store | WorktreesRepo | Scope.Scope>;
  } = {},
) =>
  Effect.gen(function* () {
    const changed = yield* Queue.sliding<void>(1);
    const closed = new Set<string>();
    const stopped: Array<string> = [];
    const memory = makeMemoryCaptureStore();
    const created: Array<CreateOptions> = [];
    const execCalls = watched<ReadonlyArray<string>>(changed);
    const seen: Array<string> = [];
    const calls: Array<string> = [];
    const logs = watched<string>(changed);
    let failure: string | null = null;
    let holderWorkspace: string | null = null;
    let joinedWorkspace: string | null = null;
    let platform: SealantClientShape | null = null;
    const tails = new Map<
      string,
      {
        readonly agentEnded: Deferred.Deferred<void> | null;
        readonly decision: Deferred.Deferred<void>;
        remaining: number;
      }
    >();
    const refusals = refusedCloses(() => options.closeFails?.() ?? false);
    const noteDecision = (sessionId: string) => {
      const tail = tails.get(sessionId);
      if (
        tail === undefined ||
        (tail.agentEnded !== null && !Deferred.isDoneUnsafe(tail.agentEnded))
      )
        return;
      tail.remaining -= 1;
      if (tail.remaining === 0) Deferred.doneUnsafe(tail.decision, Effect.void);
    };
    const loggerLayer: Layer.Layer<never> = Logger.layer([
      Logger.map(Logger.formatStructured, (entry) => {
        const line = Array.isArray(entry.message)
          ? entry.message.map(String).join(" ")
          : String(entry.message);
        logs.push(line);
        const sessionId = entry.annotations["sessionId"];
        if (
          (line === "session engine: workspace stop deferred by live leases" ||
            line === "session engine: capture drain · the workspace is in use · nothing stopped" ||
            line === "session engine: capture drain · saved · terminating" ||
            line ===
              "session engine: capture drain · the final flush answered complete, but the executor's evidence does not read saved · not saved yet") &&
          typeof sessionId === "string"
        )
          noteDecision(sessionId);
      }),
    ]);
    const hooksLayer: Layer.Layer<WorkspaceGitHooks> = Layer.effect(
      WorkspaceGitHooks,
      Effect.map(WorkspaceGitHooks, (inner) => ({
        ...inner,
        agentEnded: (event) =>
          inner.agentEnded(event).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const ready = tails.get(event.sessionId)?.agentEnded;
                if (ready !== undefined && ready !== null) Deferred.doneUnsafe(ready, Effect.void);
              }),
            ),
          ),
      })),
    ).pipe(Layer.provide(WorkspaceGitHooksLive));
    const workspaceLayer: Layer.Layer<SealantClient> = Layer.effect(
      SealantClient,
      Effect.map(SealantClient, (inner) => ({
        ...inner,
        stopWorkspace: (workspace, stopOptions) =>
          inner.stopWorkspace(workspace, stopOptions).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                // A wrong lease decision must still acknowledge and reach the original state assertions.
                if (workspace.id === joinedWorkspace)
                  for (const sessionId of tails.keys()) noteDecision(sessionId);
                Queue.offerUnsafe(changed, undefined);
              }),
            ),
          ),
      })),
    ).pipe(
      Layer.provide(
        workspacesPerOwner(
          sealantLaunchLayer(
            created,
            undefined,
            stopped,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            execCalls,
          ),
          seen,
          calls,
          {
            closed,
            ...(options.getSessionDefect === undefined
              ? {}
              : { getSessionDefect: options.getSessionDefect }),
            closeFails: refusals.closeFails,
          },
        ),
      ),
    );
    yield* withPreparedEngineEffect(
      (world, tmp) =>
        setup(tmp, world).pipe(
          Effect.tap((project) => options.prepare?.(world, tmp, project) ?? Effect.void),
        ),
      (world, tmp, project) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "together",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["claude"]);
          holderWorkspace = world.sessions.get(holder.id)?.sealantWorkspaceId ?? null;
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          const launched = yield* engine.launch(joined.id, ["claude"]).pipe(Effect.result);
          if (launched._tag === "Failure") failure = launched.failure.message;
          expect(failure, "the successful join required by this scenario").toBeNull();
          joinedWorkspace = world.sessions.get(joined.id)?.sealantWorkspaceId ?? null;
          if (platform === null) throw new Error("the platform client was not handed over");
          if (failure === null) {
            yield* then(engine, world, {
              holder: holder.id,
              joined: joined.id,
              tmp,
              project,
              platform,
              calls,
              execCalls,
              closed,
              stopped,
              memory,
              logs,
              untilChanged: signalled(changed),
              armTail: (phase, decisions = 1) =>
                Effect.gen(function* () {
                  const agentEnded = phase === "agent" ? yield* Deferred.make<void>() : null;
                  const decision = yield* Deferred.make<void>();
                  if (decisions === 0) Deferred.doneUnsafe(decision, Effect.void);
                  tails.set(joined.id, { agentEnded, decision, remaining: decisions });
                  return agentEnded === null
                    ? Deferred.await(decision)
                    : Deferred.await(agentEnded).pipe(Effect.andThen(Deferred.await(decision)));
                }),
              nextRefusedClose: refusals.nextRefusedClose,
            });
          }
        }),
      {
        captured: memory,
        gitHooksLayer: hooksLayer,
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        exposeSealant: (client) => {
          platform = client;
        },
        sealantLayer: workspaceLayer,
      },
    ).pipe(Effect.provide(loggerLayer));
    return { created, seen, calls, logs, failure, holderWorkspace, joinedWorkspace };
  });

const joinByAnotherPerson = (...args: Parameters<typeof joinByAnotherPersonEffect>) =>
  Effect.runPromise(joinByAnotherPersonEffect(...args));

/** How long a test lets what a stop forked (its tail, the settle-path cleanup) run. */
const SETTLE_WAIT = Duration.seconds(3);

const settleWindow = Effect.gen(function* () {
  const window = yield* Effect.sleep(SETTLE_WAIT).pipe(Effect.forkChild);
  yield* TestClock.adjust(SETTLE_WAIT);
  yield* Fiber.join(window);
});

/** The production close retries remain 250 ms then 500 ms, before the full settle window. */
const refusingStop = <A>(
  action: Effect.Effect<A, unknown>,
  join: Pick<JoinByAnother, "nextRefusedClose">,
) =>
  Effect.gen(function* () {
    const first = yield* join.nextRefusedClose();
    const stop = yield* action.pipe(Effect.forkChild);
    yield* Deferred.await(first);
    const second = yield* join.nextRefusedClose();
    yield* TestClock.adjust("250 millis");
    yield* Deferred.await(second);
    const third = yield* join.nextRefusedClose();
    yield* TestClock.adjust("500 millis");
    yield* Deferred.await(third);
    return yield* Fiber.join(stop);
  });

/** Whether the holder's agent row still reads live. */
const holderAgentLive = (world: World, holder: SessionId) =>
  [...world.processes.values()].some(
    (process) =>
      process.sessionId === holder && process.kind === "agent-pty" && process.exitedAt === null,
  );

/** The mark a refused close of `shell` puts on its session's line, keyed by its id. */
const wordsOf = (shell: SessionProcess | undefined) =>
  `(${(shell?.id ?? "").slice(0, 8)}) could not be stopped`;

/** A platform call's outcome in one word: `answered`, or its failure's code. */
const tell = <A>(effect: Effect.Effect<A, SealantPlatformError>) =>
  effect.pipe(Effect.match({ onSuccess: () => "answered", onFailure: (e) => e.code }));

/** The joiner's agent process, as the terminal route resolves it for `?session=`. */
const joinedAgentOf = (world: World, joined: SessionId) => {
  const agent = [...world.processes.values()].find(
    (process) => process.sessionId === joined && process.kind === "agent-pty",
  );
  if (agent === undefined || agent.sealantSessionId === null) {
    throw new Error("the joined session has no agent PTY");
  }
  return { workspaceId: agent.sealantWorkspaceId, ptyId: agent.sealantSessionId };
};

/** How long these cases let a launch wait for a worktree's previous executor (`leaseWait`). */
const LEASE_WAIT = Duration.seconds(1);

/** The PTY watcher's look (`watchProcess`): an exit is read at its next one. */
const WATCH_POLL = Duration.seconds(2);

describe("a join by another person into a live executor (alpha 2026-10-06, 9e486cfc)", () => {
  it("finds the holder's executor as its owner and joins it, never waiting on a lookup only the owner may make", async () => {
    const run = await joinByAnotherPerson(() => Effect.void);
    // On alpha: `holder: 'unreachable'`, the session line "waiting · the previous session in this
    // worktree is not answering", and after `leaseWait` (30 min) `worktree leased · held by …`.
    expect(run.failure).toBeNull();
    expect(run.logs.some((line) => line.includes("joining the lease holder"))).toBe(true);
    expect(run.created).toHaveLength(1);
    expect(run.holderWorkspace).not.toBeNull();
    expect(run.joinedWorkspace).toBe(run.holderWorkspace);
    // The holder's executor is never asked about as the joiner: every call about it, the join's
    // own process included, is made as its creator.
    expect(run.seen).not.toContain(`${MARIA}:404`);
    expect(run.calls.filter((call) => !call.endsWith("user-fixture:found"))).toEqual([]);
    expect(run.calls).toContain("openSession user-fixture:found");
  });

  it("after the join, the joiner's own verbs reach the executor they run in: a shell opens", async () => {
    let shell: string | null = "not asked";
    const run = await joinByAnotherPerson((engine, _world, { joined }) =>
      engine.openShell(joined).pipe(
        Effect.match({
          onSuccess: () => {
            shell = null;
          },
          onFailure: (error) => {
            shell = error.message;
          },
        }),
      ),
    );
    expect(run.failure).toBeNull();
    expect(shell).toBeNull();
    expect(run.seen).not.toContain(`${MARIA}:404`);
  });

  it("the joiner's terminal attaches as the terminal route asks for it, as the session's owner", async () => {
    let attached: string | null = null;
    let expected: string | null = null;
    const run = await joinByAnotherPerson((_engine, world, join) =>
      Effect.gen(function* () {
        const agent = joinedAgentOf(world, join.joined);
        expected = agent.ptyId;
        // apps/api/src/routes/tty.ts: the workspace, then the PTY, as the session's owner (the
        // joiner); the client asks as the workspace's creator.
        const pty = yield* join.platform.getWorkspace(agent.workspaceId).pipe(
          Effect.flatMap((workspace) => join.platform.getSession(workspace, agent.ptyId)),
          asSealantUser(MARIA),
        );
        attached = pty.id;
      }),
    );
    expect(run.failure).toBeNull();
    expect(attached).not.toBeNull();
    expect(attached).toBe(expected);
    expect(run.seen).not.toContain(`${MARIA}:404`);
    expect(run.calls).toContain("getSession user-fixture:found");
  });

  it("a Service the joiner runs starts in the executor, and stops there", async () => {
    let started: string | null = null;
    let stopped: string | null = null;
    const run = await joinByAnotherPerson((engine, _world, { joined }) =>
      Effect.gen(function* () {
        const service = yield* engine.runService(joined, ["pnpm", "dev"], 3000, "web");
        started = service.attempts[0]?.status ?? null;
        const after = yield* engine.stopService(service.service.id);
        stopped = after.service.id;
      }),
    );
    expect(run.failure).toBeNull();
    expect(started).toBe("running");
    expect(stopped).not.toBeNull();
    expect(run.seen).not.toContain(`${MARIA}:404`);
  });

  it.effect(
    "a git op through the workspace: a repository the joiner adds is cloned in the executor",
    () =>
      Effect.gen(function* () {
        let listed: ReadonlyArray<readonly [string, string, string | null]> = [];
        const run = yield* joinByAnotherPersonEffect(
          (engine, _world, join) =>
            Effect.gen(function* () {
              yield* engine.addRepository(join.joined, {
                project: "core",
                name: null,
                worktree: null,
              });
              yield* join.untilChanged(
                () => join.execCalls.some((argv) => argv.join("\n").includes("git clone --quiet")),
                "the clone in the workspace",
              );
              // The add's fiber writes its row `ready` before it says so.
              yield* join.untilChanged(
                () => join.logs.includes("session engine: repository added"),
                "the row settled",
              );
              const rows = yield* engine.listRepositories(join.joined);
              listed = rows.map((row) => [row.name, row.state, row.error] as const);
            }),
          {
            // The sibling's origin and adoption are git I/O: before the engine, as the project's.
            prepare: (world, tmp, project) =>
              setupSibling(tmp, world, "core", project.originUrl ?? ""),
          },
        );
        expect(run.failure).toBeNull();
        expect(listed).toEqual([["core", "ready", null]]);
        expect(run.seen).not.toContain(`${MARIA}:404`);
      }),
  );

  it("a checkpoint of the joiner's session flushes the executor it runs in, and its files are read there", async () => {
    let checkpoint: string | null = null;
    const run = await joinByAnotherPerson((engine, _world, { joined }) =>
      Effect.gen(function* () {
        const taken = yield* engine.checkpointNow(joined, "user-mark");
        checkpoint = taken.id;
        // The transcript reads the conversation's file through the executor.
        yield* engine.transcript(joined);
      }),
    );
    expect(run.failure).toBeNull();
    expect(checkpoint).not.toBeNull();
    expect(run.calls).toContain("captureFlush user-fixture:found");
    expect(run.seen).not.toContain(`${MARIA}:404`);
  });

  it.effect(
    "says what it observed when the platform does not find a live holder's workspace: a 404, never 'not answering'",
    () =>
      Effect.gen(function* () {
        let lookupsRejected = false;
        const phases: Array<string> = [];
        let refusal: string | null = null;
        const { fixture, untilChanged } = yield* signalledFixture("mend-lease-404-");
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const holder = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "together",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(holder.id, ["claude"]);
              const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: MARIA,
              });
              // The holder's lease stays live; Core answers 404 for its workspace, whoever asks.
              lookupsRejected = true;
              const launch = yield* Effect.forkChild(
                engine.launch(joined.id, ["claude"]).pipe(Effect.result),
              );
              yield* untilChanged(() => {
                const summary = world.sessions.get(joined.id)?.summary ?? "";
                if (summary.includes("waiting")) phases.push(summary);
                return phases.length > 0;
              }, "the waiting line");
              // The launch looks again every `leaseWaitInterval` until `leaseWait` has passed;
              // only then is the last reading answered, and refused.
              yield* TestClock.adjust(Duration.subtract(LEASE_WAIT, Duration.millis(1)));
              expect(launch.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(Duration.millis(1));
              const result = yield* Fiber.join(launch);
              if (result._tag === "Failure") refusal = result.failure.message;
            }),
          {
            fixture,
            captured: makeMemoryCaptureStore(),
            prepareWorld: (world) => world.members.set(MARIA, "member"),
            drainPolicy: { leaseWait: LEASE_WAIT },
            sealantLayer: sealantLaunchLayer(
              [],
              undefined,
              undefined,
              undefined,
              () => lookupsRejected,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
            ),
          },
        );
        expect(phases[0]).toContain(
          "the previous session in this worktree renews its lease, but the platform did not find its workspace (404)",
        );
        expect(phases.join("\n")).not.toContain("is not answering");
        expect(refusal).toContain("worktree leased");
      }),
  );

  it("refuses to act for a joiner who lost access, while observing and ending still reach the executor", async () => {
    const outcomes: Record<string, string> = {};
    const run = await joinByAnotherPerson((engine, world, join) =>
      Effect.gen(function* () {
        const agent = joinedAgentOf(world, join.joined);
        const exec = (as: string) =>
          tell(
            join.platform.getWorkspace(agent.workspaceId).pipe(
              Effect.flatMap((workspace) => join.platform.exec(workspace, ["true"])),
              asSealantUser(as),
            ),
          );
        const lookup = (as: string) =>
          tell(join.platform.getWorkspace(agent.workspaceId).pipe(asSealantUser(as)));
        // Removed from the organization: nothing more runs for her there.
        world.members.delete(MARIA);
        outcomes["shell"] = yield* engine
          .openShell(join.joined)
          .pipe(Effect.match({ onSuccess: () => "opened", onFailure: (error) => error.message }));
        outcomes["exec"] = yield* exec(MARIA);
        // Looking it up is observing: as the creator, so a removal check never reads it gone.
        outcomes["lookup"] = yield* lookup(MARIA);
        outcomes["creator"] = yield* exec("user-fixture");
        // Someone outside the organization has no standing either.
        outcomes["outsider"] = yield* exec("user-outsider");
        // Nor a member kept out of a private project.
        world.members.set(MARIA, "member");
        world.projects.set(
          join.project.id,
          new Project({ ...join.project, visibility: "private", createdByUserId: "user-fixture" }),
        );
        outcomes["private"] = yield* exec(MARIA);
      }),
    );
    expect(run.failure).toBeNull();
    expect(outcomes).toEqual({
      shell: "you no longer have access to this project, so nothing runs for you in its workspaces",
      exec: "no_standing",
      lookup: "answered",
      creator: "answered",
      outsider: "no_standing",
      private: "no_standing",
    });
    // Nothing about the executor was ever asked as Maria: she could only have seen a 404.
    expect(run.seen).not.toContain(`${MARIA}:404`);
  });

  it("removing a joiner ends their agent, shell and Service in the holder's executor, which keeps running", async () => {
    let ended: Record<string, unknown> = {};
    await joinByAnotherPerson((engine, world, join) =>
      Effect.gen(function* () {
        const shell = yield* engine.openShell(join.joined);
        const service = yield* engine.runService(join.joined, ["pnpm", "dev"], 3000, "web");
        const agent = joinedAgentOf(world, join.joined);
        world.members.delete(MARIA);
        const done = yield* engine.windDownPerson(MARIA);
        const rows = [...world.processes.values()].filter((p) => p.sessionId === join.joined);
        const holderLive = [...world.processes.values()].filter(
          (p) => p.sessionId === join.holder && p.exitedAt === null,
        );
        ended = {
          done,
          // The platform shows them gone: every PTY of hers was closed.
          agentClosed: join.closed.has(agent.ptyId),
          shellClosed: join.closed.has(shell.sealantSessionId ?? ""),
          serviceClosed: join.closed.has(service.attempts[0]?.sealantSessionId ?? ""),
          // And Mend recorded them ended.
          live: rows.filter((p) => p.exitedAt === null).length,
          holderLive: holderLive.length,
          stopped: join.stopped,
        };
      }),
    );
    expect(ended).toEqual({
      done: { stopped: 1, retired: [], remaining: 0 },
      agentClosed: true,
      shellClosed: true,
      serviceClosed: true,
      live: 0,
      // The holder's agent runs on; its executor was never stopped.
      holderLive: 1,
      stopped: [],
    });
  });

  it.effect(
    "a Stop whose close the platform refuses ends nothing: the joiner's agent and shell stay, and so do the holder's agent and executor",
    () =>
      Effect.gen(function* () {
        let closing = false;
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect(
          (engine, world, join) =>
            Effect.gen(function* () {
              const agent = joinedAgentOf(world, join.joined);
              const shell = yield* engine.openShell(join.joined);
              closing = true;
              yield* refusingStop(engine.stop(join.joined), join);
              // Read once whatever the stop forked has had its time (review 2 of mend#558, P1).
              yield* settleWindow;
              const live = (id: string | null) =>
                [...world.processes.values()].find((p) => p.sealantSessionId === id)?.exitedAt ===
                null;
              state = {
                joinerAgentLive: live(agent.ptyId),
                joinerShellLive: live(shell.sealantSessionId),
                holderAgentLive: holderAgentLive(world, join.holder),
                stopped: [...join.stopped],
                summary: world.sessions.get(join.joined)?.summary ?? "",
              };
              // Once the platform answers, the next stop ends it, and the line forgets the failure.
              closing = false;
              // Her shell keeps this session idle: the tail completes harvest and its hook,
              // then returns before the workspace lease check.
              const tail = yield* join.armTail("agent", 0);
              yield* engine.stop(join.joined);
              yield* tail;
              yield* settleWindow;
              state = {
                ...state,
                closedAfter: join.closed.has(agent.ptyId),
                summaryAfter: world.sessions.get(join.joined)?.summary ?? "",
                holderAgentLiveAfter: holderAgentLive(world, join.holder),
                stoppedAfter: [...join.stopped],
              };
            }),
          { closeFails: () => closing },
        );
        expect(state).toEqual({
          joinerAgentLive: true,
          // A failed agent close is not "no agent to close": the person's shells stay.
          joinerShellLive: true,
          holderAgentLive: true,
          stopped: [],
          summary: expect.stringContaining(
            "could not be stopped · the platform did not close it · stop again",
          ),
          closedAfter: true,
          summaryAfter: expect.not.stringContaining("could not be stopped"),
          holderAgentLiveAfter: true,
          stoppedAfter: [],
        });
      }),
    30_000,
  );

  it.effect(
    "removing a joiner who has only a shell left in the holder's executor ends the shell, never the holder's agent or executor",
    () =>
      Effect.gen(function* () {
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            const shell = yield* engine.openShell(join.joined);
            // Her agent was stopped earlier: a stop that ended a live agent keeps her shell.
            const agentTail = yield* join.armTail("agent", 0);
            yield* engine.stop(join.joined);
            yield* agentTail;
            yield* settleWindow;
            world.members.delete(MARIA);
            // Shell close checks the lease inline; the following Stop checks it again in its tail.
            const shellTail = yield* join.armTail("sweep", 2);
            yield* engine.windDownPerson(MARIA);
            yield* shellTail;
            yield* settleWindow;
            state = {
              shellClosed: join.closed.has(shell.sealantSessionId ?? ""),
              holderAgentLive: holderAgentLive(world, join.holder),
              stopped: [...join.stopped],
            };
          }),
        );
        expect(state).toEqual({ shellClosed: true, holderAgentLive: true, stopped: [] });
      }),
    30_000,
  );

  it.effect(
    "a second Stop of a joiner leaves the holder's agent and executor running",
    () =>
      Effect.gen(function* () {
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            const agentTail = yield* join.armTail("agent");
            yield* engine.stop(join.joined);
            yield* agentTail;
            yield* settleWindow;
            const secondTail = yield* join.armTail("sweep");
            yield* engine.stop(join.joined);
            yield* secondTail;
            yield* settleWindow;
            state = {
              joinedStatus: world.sessions.get(join.joined)?.status,
              holderAgentLive: holderAgentLive(world, join.holder),
              holderStatus: world.sessions.get(join.holder)?.status,
              stopped: [...join.stopped],
            };
          }),
        );
        expect(state).toEqual({
          joinedStatus: "stopped",
          holderAgentLive: true,
          holderStatus: "running",
          stopped: [],
        });
      }),
    30_000,
  );

  it.effect(
    "reconciles access: a joiner kept out of a project gone private has their processes ended, the holder's run on",
    () =>
      Effect.gen(function* () {
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            const agent = joinedAgentOf(world, join.joined);
            world.projects.set(
              join.project.id,
              new Project({
                ...join.project,
                visibility: "private",
                createdByUserId: "user-fixture",
              }),
            );
            const tail = yield* join.armTail("agent");
            const done = yield* engine.reconcileAccess();
            yield* tail;
            yield* settleWindow;
            state = {
              done,
              joinerClosed: join.closed.has(agent.ptyId),
              joinerSummary: world.sessions.get(join.joined)?.summary,
              holderAgentLive: holderAgentLive(world, join.holder),
              stopped: [...join.stopped],
              // Nothing left to do on the next tick.
              again: yield* engine.reconcileAccess(),
              audit: world.audit.map((event) => ({
                action: event.action,
                actorUserId: event.actorUserId,
                subjectType: event.subjectType,
                reason: event.data?.["reason"],
                words: event.data?.["words"],
              })),
            };
          }),
        );
        expect(state).toEqual({
          done: { stopped: 1, refused: 0, retired: [] },
          joinerClosed: true,
          joinerSummary: STOPPED_LOST_SIGHT,
          holderAgentLive: true,
          stopped: [],
          again: { stopped: 0, refused: 0, retired: [] },
          // On the organization's record, as Mend's, with the reason the session line gives.
          audit: [
            {
              action: "session.stopped_no_access",
              actorUserId: MARIA,
              subjectType: "session",
              reason: "no_standing",
              words: STOPPED_LOST_SIGHT,
            },
          ],
        });
      }),
    30_000,
  );

  it.effect(
    "a project going private stops nobody's own session: the executor's creator and the project's creator keep running, and so does flipping it back",
    () =>
      Effect.gen(function* () {
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            const agent = joinedAgentOf(world, join.joined);
            // Maria created the project; the executor is user-fixture's, who cannot see it once private.
            world.projects.set(
              join.project.id,
              new Project({ ...join.project, visibility: "private", createdByUserId: MARIA }),
            );
            const whenPrivate = yield* engine.reconcileAccess();
            yield* settleWindow;
            const live = () => ({
              holderAgentLive: holderAgentLive(world, join.holder),
              joinerAgentLive:
                [...world.processes.values()].find((p) => p.sealantSessionId === agent.ptyId)
                  ?.exitedAt === null,
            });
            const afterPrivate = live();
            world.projects.set(
              join.project.id,
              new Project({ ...join.project, visibility: "shared", createdByUserId: MARIA }),
            );
            const whenShared = yield* engine.reconcileAccess();
            state = {
              whenPrivate,
              afterPrivate,
              whenShared,
              afterShared: live(),
              stopped: [...join.stopped],
              audit: world.audit.length,
              holderSummary: world.sessions.get(join.holder)?.summary ?? null,
            };
          }),
        );
        expect(state).toEqual({
          whenPrivate: { stopped: 0, refused: 0, retired: [] },
          afterPrivate: { holderAgentLive: true, joinerAgentLive: true },
          whenShared: { stopped: 0, refused: 0, retired: [] },
          afterShared: { holderAgentLive: true, joinerAgentLive: true },
          stopped: [],
          audit: 0,
          holderSummary: expect.not.stringContaining("stopped"),
        });
      }),
    30_000,
  );

  it.effect(
    "a refused access stop reports zero ended and writes no stopped audit event",
    () =>
      Effect.gen(function* () {
        let refusing = false;
        yield* joinByAnotherPersonEffect(
          (engine, world, join) =>
            Effect.gen(function* () {
              world.members.delete(MARIA);
              refusing = true;
              for (let round = 0; round < 2; round += 1) {
                expect(yield* refusingStop(engine.reconcileAccess(), join)).toEqual({
                  stopped: 0,
                  refused: 1,
                  retired: [],
                });
                expect(world.audit).toEqual([]);
                expect(world.sessions.get(join.joined)?.summary).toContain("could not be stopped");
                expect(holderAgentLive(world, join.holder)).toBe(true);
              }
              refusing = false;
              expect(yield* engine.reconcileAccess()).toEqual({
                stopped: 1,
                refused: 0,
                retired: [],
              });
              expect(world.sessions.get(join.joined)?.summary).toBe(STOPPED_NOT_MEMBER);
              expect(world.audit).toMatchObject([
                {
                  subjectId: join.joined,
                  actorUserId: MARIA,
                  data: { reason: "not_member" },
                },
              ]);
            }),
          { closeFails: () => refusing },
        );
      }),
    30_000,
  );

  it.each(["replacement", "relaunch"] as const)(
    "a refused Stop preserves an existing %s drain",
    async (reason) => {
      let refusing = false;
      await joinByAnotherPerson(
        (engine, world, join) =>
          Effect.gen(function* () {
            const session = world.sessions.get(join.joined);
            if (session === undefined) throw new Error("missing joined session");
            world.sessions.set(
              session.id,
              new Session({
                ...session,
                captureDrain: reason,
                captureDrainRequestedAt: now(),
                captureDrainProgressAt: now(),
              }),
            );
            if (reason === "relaunch") world.relaunches.set(session.id, "claude");
            refusing = true;
            yield* engine.stop(session.id);
            expect(world.sessions.get(session.id)?.captureDrain).toBe(reason);
            expect(world.relaunches.has(session.id)).toBe(reason === "relaunch");
            expect(holderAgentLive(world, join.holder)).toBe(true);
          }),
        { closeFails: () => refusing },
      );
    },
    30_000,
  );

  it.effect(
    "a refused Stop whose agent a finished relaunch drain ended anyway is a stop: nothing stranded, nothing relaunched (review 5 of mend#558)",
    () =>
      Effect.gen(function* () {
        // What the relaunch's drain does while the platform refuses the Stop's close: it saves and
        // ends the agent and its drain is over.
        let duringClose: (() => void) | null = null;
        let refusing = false;
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect(
          (engine, world, join) =>
            Effect.gen(function* () {
              const session = world.sessions.get(join.joined);
              if (session === undefined) throw new Error("missing joined session");
              const agent = joinedAgentOf(world, join.joined);
              world.sessions.set(
                session.id,
                new Session({
                  ...session,
                  captureDrain: "relaunch",
                  captureDrainRequestedAt: world.clock.now(),
                  captureDrainProgressAt: world.clock.now(),
                }),
              );
              world.relaunches.set(session.id, "claude");
              refusing = true;
              duringClose = () => {
                duringClose = null;
                const row = [...world.processes.values()].find(
                  (p) => p.sealantSessionId === agent.ptyId,
                );
                if (row !== undefined) {
                  world.processes.set(
                    row.id,
                    new SessionProcess({ ...row, exitedAt: world.clock.now(), status: "stopped" }),
                  );
                }
                const current = world.sessions.get(session.id);
                if (current !== undefined) {
                  world.sessions.set(session.id, new Session({ ...current, captureDrain: null }));
                }
              };
              const tail = yield* join.armTail("sweep");
              yield* refusingStop(engine.stop(session.id), join);
              yield* tail;
              yield* settleWindow;
              state = {
                summary: world.sessions.get(session.id)?.summary ?? "",
                relaunch: world.relaunches.has(session.id),
                holderAgentLive: holderAgentLive(world, join.holder),
              };
            }),
          {
            // Refused on every try; the first try is when the relaunch finishes.
            closeFails: () => {
              if (duringClose === null) return refusing;
              duringClose();
              return true;
            },
          },
        );
        expect(state).toEqual({
          summary: expect.not.stringContaining("could not be stopped"),
          // The stop superseded the plan: nothing launches after it.
          relaunch: false,
          holderAgentLive: true,
        });
      }),
    30_000,
  );

  it("a renamed shell's refusal words still come off once it is stopped (review 5 of mend#558)", async () => {
    let refusing = false;
    let state: Record<string, unknown> = {};
    await joinByAnotherPerson(
      (engine, world, join) =>
        Effect.gen(function* () {
          const shell = yield* engine.openShell(join.joined);
          refusing = true;
          yield* engine.stopShell(shell.id);
          const refused = world.sessions.get(join.joined)?.summary ?? "";
          yield* engine.renameShell(shell.id, "renamed");
          refusing = false;
          yield* engine.stopShell(shell.id);
          state = {
            refused: refused.includes("could not be stopped"),
            after: world.sessions.get(join.joined)?.summary ?? "",
            ended: world.processes.get(shell.id)?.exitedAt !== null,
          };
        }),
      { closeFails: () => refusing },
    );
    expect(state).toEqual({
      refused: true,
      after: expect.not.stringContaining("could not be stopped"),
      ended: true,
    });
  }, 30_000);

  it.effect(
    "reconciliation stops a removed creator's own session with a direct reason and records both people",
    () =>
      Effect.gen(function* () {
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            world.members.delete("user-fixture");
            expect(yield* engine.reconcileAccess()).toEqual({
              stopped: 2,
              refused: 0,
              retired: ["workspace-1"],
            });
            expect(world.sessions.get(join.holder)?.summary).toBe(STOPPED_NOT_MEMBER);
            expect(world.sessions.get(join.joined)?.summary).toBe(EXECUTOR_RETIRED);
            expect(world.audit.map((event) => event.data?.["reason"]).toSorted()).toEqual([
              "creator_not_member",
              "not_member",
            ]);
            yield* join.untilChanged(() => join.stopped.length === 1, "the saved executor ends");
          }),
        );
      }),
    30_000,
  );

  it("one defective Stop leaves sibling Stops running", async () => {
    let defectivePty: string | null = null;
    await joinByAnotherPerson(
      (engine, world, join) =>
        Effect.gen(function* () {
          const session = world.sessions.get(join.joined);
          if (session === undefined) throw new Error("missing joined session");
          const sibling = yield* engine.provisionSessionIn(session.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launch(sibling.id, ["claude"]);
          const siblingPty = joinedAgentOf(world, sibling.id);
          defectivePty = joinedAgentOf(world, join.joined).ptyId;
          world.members.delete(MARIA);
          expect(yield* engine.reconcileAccess()).toEqual({ stopped: 1, refused: 1, retired: [] });
          expect(join.closed.has(siblingPty.ptyId)).toBe(true);
          expect(join.closed.has(defectivePty)).toBe(false);
          expect(holderAgentLive(world, join.holder)).toBe(true);
          expect(world.audit.map((event) => event.subjectId)).toEqual([sibling.id]);
        }),
      { getSessionDefect: (ptyId) => ptyId === defectivePty },
    );
  }, 30_000);

  it.effect(
    "failed shell Stops survive restart, each on its own words, until that shell is observed ended",
    () =>
      Effect.gen(function* () {
        const { fixture, untilChanged } = yield* signalledFixture("mend-stop-restart-");
        const memory = makeMemoryCaptureStore();
        const states = new Map<string, InteractiveSessionStatus>();
        const shells: Array<SessionProcess> = [];
        let refusing = false;
        const refusals = refusedCloses(() => refusing);
        const platform = workspacesPerOwner(
          sealantLaunchLayer([], undefined, [], undefined, undefined, undefined, states),
          [],
          [],
          { closeFails: refusals.closeFails },
        );
        const options = { fixture, captured: memory, sealantLayer: platform };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["claude"]);
              shells.push(yield* engine.openShell(session.id), yield* engine.openShell(session.id));
              refusing = true;
              for (const shell of shells) yield* refusingStop(engine.stopShell(shell.id), refusals);
              const summary = world.sessions.get(session.id)?.summary ?? "";
              expect(summary).toContain(wordsOf(shells[0]));
              expect(summary).toContain(wordsOf(shells[1]));
            }),
          options,
        );
        yield* withPreparedEngineEffect(
          () => Effect.void,
          (world) =>
            Effect.gen(function* () {
              yield* SessionEngine;
              const first = shells[0];
              const second = shells[1];
              if (first?.sealantSessionId == null || second?.sealantSessionId == null)
                throw new Error("missing shells");
              const summary = () => world.sessions.get(first.sessionId)?.summary ?? "";
              expect(summary()).toContain(wordsOf(first));
              states.set(first.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The restarted engine watches each live shell again; its next look reads the exit.
              yield* TestClock.adjust(WATCH_POLL);
              yield* untilChanged(
                () => world.processes.get(first.id)?.exitedAt != null,
                "first shell observed ended",
              );
              yield* untilChanged(
                () => !summary().includes(wordsOf(first)),
                "the first shell's words",
              );
              // The second shell's refusal is its own, and stays.
              expect(summary()).toContain(wordsOf(second));
              states.set(second.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              yield* TestClock.adjust(WATCH_POLL);
              yield* untilChanged(
                () => world.processes.get(second.id)?.exitedAt != null,
                "second shell observed ended",
              );
              yield* untilChanged(() => !summary().includes("stop again"), "refusal cleared");
              expect(holderAgentLive(world, first.sessionId)).toBe(true);
            }),
          options,
        );
      }),
    30_000,
  );

  it.effect(
    "after a restart a healthy shell is never taken for its refused sibling (review 4 of mend#558)",
    () =>
      Effect.gen(function* () {
        const { fixture, untilChanged } = yield* signalledFixture("mend-stop-sibling-");
        const memory = makeMemoryCaptureStore();
        const states = new Map<string, InteractiveSessionStatus>();
        const shells: Array<SessionProcess> = [];
        const closed = new Set<string>();
        let refusing = false;
        const refusals = refusedCloses(() => refusing);
        const platform = workspacesPerOwner(
          sealantLaunchLayer([], undefined, [], undefined, undefined, undefined, states),
          [],
          [],
          { closeFails: refusals.closeFails, closed },
        );
        const options = { fixture, captured: memory, sealantLayer: platform };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, _tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["claude"]);
              shells.push(yield* engine.openShell(session.id), yield* engine.openShell(session.id));
              refusing = true;
              const refused = shells[0];
              if (refused === undefined) throw new Error("missing shell");
              yield* refusingStop(engine.stopShell(refused.id), refusals);
              refusing = false;
            }),
          options,
        );
        yield* withPreparedEngineEffect(
          () => Effect.void,
          (world) =>
            Effect.gen(function* () {
              yield* SessionEngine;
              const refused = shells[0];
              const healthy = shells[1];
              if (refused?.sealantSessionId == null || healthy?.sealantSessionId == null)
                throw new Error("missing shells");
              states.set(refused.sealantSessionId, {
                status: "exited",
                exitCode: 0,
                outputHighWater: 0n,
              });
              // The restarted engine watches each live shell again; its next look reads the exit.
              yield* TestClock.adjust(WATCH_POLL);
              yield* untilChanged(
                () => world.processes.get(refused.id)?.exitedAt != null,
                "the refused shell observed ended",
              );
              yield* untilChanged(
                () =>
                  !(world.sessions.get(refused.sessionId)?.summary ?? "").includes("stop again"),
                "its words cleared",
              );
              // The healthy shell runs on, never marked refused.
              expect(world.processes.get(healthy.id)).toMatchObject({
                id: healthy.id,
                sessionId: healthy.sessionId,
                sealantRunId: healthy.sealantRunId,
                sealantSessionId: healthy.sealantSessionId,
                kind: "shell",
                status: "running",
                exitedAt: null,
              });
              expect(closed.has(healthy.sealantSessionId)).toBe(false);
            }),
          options,
        );
      }),
    30_000,
  );

  it.effect(
    "removing the person who started the executor retires it: the joiner is stopped and told, and it saves and ends",
    () =>
      Effect.gen(function* () {
        let state: Record<string, unknown> = {};
        yield* joinByAnotherPersonEffect((engine, world, join) =>
          Effect.gen(function* () {
            const agent = joinedAgentOf(world, join.joined);
            world.members.delete("user-fixture");
            // Nothing new runs in it for anyone: the creator's identity is no longer lent.
            const refused = yield* engine
              .openShell(join.joined)
              .pipe(
                Effect.match({ onSuccess: () => "opened", onFailure: (error) => error.message }),
              );
            const done = yield* engine.windDownPerson("user-fixture");
            yield* join.untilChanged(() => join.stopped.length > 0, "the retired executor's stop");
            const joined = world.sessions.get(join.joined);
            state = {
              refused,
              retired: done.retired,
              joinerClosed: join.closed.has(agent.ptyId),
              joinerStatus: joined?.status,
              joinerSummary: joined?.summary,
              // It saved first: the final flush before the stop, through the normal Stop.
              flushedBeforeStop: join.calls.some((call) => call.startsWith("captureFlush")),
              stopped: join.stopped,
            };
          }),
        );
        expect(state).toEqual({
          refused:
            "the person who started this workspace is no longer a member of this organization, so nothing new runs in it · start a session of your own in this worktree",
          retired: ["workspace-1"],
          joinerClosed: true,
          joinerStatus: "stopped",
          joinerSummary: EXECUTOR_RETIRED,
          flushedBeforeStop: true,
          stopped: ["workspace-1"],
        });
      }),
  );

  it("a removed joiner's lookups never read the holder's executor gone: removing the project still waits for it", async () => {
    let holds: ReadonlyArray<CaptureHold> = [];
    const run = await joinByAnotherPerson((engine, world, join) =>
      Effect.gen(function* () {
        world.members.delete(MARIA);
        const session = world.sessions.get(join.joined);
        if (session === undefined) throw new Error("no joined session");
        holds = yield* engine.captureHolds(session.worktreeId);
      }),
    );
    // The executor itself holds the worktree, seen as its creator sees it, not only the lease.
    expect(holds.map((hold) => hold.kind)).toContain("executor");
    expect(run.seen).not.toContain(`${MARIA}:404`);
  });
});
