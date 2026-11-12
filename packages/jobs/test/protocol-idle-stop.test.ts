import {
  AgentConversationRepo,
  makeScreensMemory,
  ScreensRepo,
  ServicesRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreesRepo,
  type NewSessionControlEvent,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  ViewerConnectionId,
  WorktreeId,
} from "@mend/domain";
import type { SessionRuntime } from "@mend/domain";
import {
  workspaceWakeLaunchId,
  AgentRequest,
  AgentTurn,
  Session,
  SessionProcess,
  Worktree,
  type AgentTurnStatus,
  type CaptureReading,
  type SessionProcessKind,
} from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProtocolIdleStop, ProtocolIdleStopLive } from "../src/protocol-idle-stop.ts";

const SESSION = SessionId.make("session-1");
const AGENT = SessionProcessId.make("agent-1");
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const sessionRow = (status: Session["status"], settledAt: Date | null) =>
  new Session({
    id: SESSION,
    projectId: ProjectId.make("p-billing"),
    worktreeId: WorktreeId.make("wt-1"),
    harness: "claude",
    providerSessionId: "provider-1",
    label: null,
    worktree: "wt-1",
    branch: "mend/wt-1",
    baseSha: Sha.make("abc"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: "protocol-1",
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: "alice",
    origin: "slack",
    hasTranscript: null,
    status,
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: minutesAgo(60),
    settledAt,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  });

const processRow = (kind: SessionProcessKind, live: boolean, id: string = `${kind}-1`) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId: SESSION,
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: "protocol-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "shell" ? null : "claude",
    providerSessionId: kind === "agent-protocol" ? "provider-1" : null,
    protocolOptions: null,
    label: kind,
    argv: [],
    status: live ? "running" : "stopped",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: minutesAgo(60),
    exitedAt: live ? null : minutesAgo(1),
    updatedAt: minutesAgo(60),
  });

const turnRow = (status: AgentTurnStatus, endedMinutesAgo: number | null) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${status}`),
    sessionId: SESSION,
    processId: AGENT,
    ordinal: 1,
    author: "alice",
    input: "fix the flaky login test",
    status,
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: minutesAgo(40),
    startedAt: minutesAgo(40),
    endedAt: endedMinutesAgo === null ? null : minutesAgo(endedMinutesAgo),
  });

const pendingRequest = new AgentRequest({
  id: AgentRequestId.make("request-1"),
  sessionId: SESSION,
  processId: AGENT,
  turnId: AgentTurnId.make("turn-completed"),
  kind: "user-input",
  providerRequestId: "provider-request-1",
  providerItemId: null,
  title: null,
  detail: null,
  questions: null,
  status: "pending",
  decision: null,
  decidedBy: null,
  answers: null,
  createdAt: minutesAgo(30),
  decidedAt: null,
});

interface WorldOptions {
  readonly minutes?: string;
  readonly turns?: ReadonlyArray<AgentTurn>;
  readonly requests?: ReadonlyArray<AgentRequest>;
  readonly liveServices?: number;
  /** Background tasks still running (a workflow the agent started). */
  readonly runningTasks?: number;
  /** Minutes since a background task last changed. */
  readonly taskChangedMinutesAgo?: number;
  readonly shells?: boolean;
  /** The session's screen, live: whether a person holds its input. */
  readonly screen?: { readonly held: boolean };
  readonly agentKind?: SessionProcessKind;
  readonly stopFails?: boolean;
  /** What the executor answers when the idle stop reads its captures; null outside capture mode. */
  readonly captures?: ReadonlyArray<CaptureReading | null>;
  /** The worktree's runtime; Docker by default. */
  readonly runtime?: SessionRuntime | null;
  /** How much the open shell has printed, read by read; the last one repeats. null: no answer. */
  readonly shellHighWaters?: ReadonlyArray<bigint | null>;
}

/** One pass of one worker. */
const sweep = (idle: ProtocolIdleStop["Service"]) => Effect.runPromise(idle.sweep());

/** One pass of one worker, this many minutes from now. */
const sweepAt = (idle: ProtocolIdleStop["Service"], minutesFromNow: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now() + minutesFromNow * 60_000);
      return yield* idle.sweep();
    }).pipe(Effect.provide(TestClock.layer())),
  );

/**
 * The shared database as fakes: one session, its processes, turns and requests, and the claim
 * column. `stop` settles the session as the engine's Stop does; each worker builds its own
 * ProtocolIdleStop over the same state.
 */
const world = (options: WorldOptions = {}) => {
  const state = {
    session: sessionRow("running", null),
    idleStoppedAt: null as Date | null,
    processes: [
      processRow(options.agentKind ?? "agent-protocol", true, AGENT),
      ...(options.shells === true ? [processRow("shell", true)] : []),
      ...(options.screen === undefined ? [] : [processRow("screen", true)]),
    ] as ReadonlyArray<SessionProcess>,
    screenStops: [] as Array<string>,
    stops: [] as Array<{ readonly sessionId: SessionId; readonly summary: string | null }>,
    control: [] as Array<NewSessionControlEvent>,
    released: 0,
    captureReads: 0,
    /** When a client was last on one of the session's terminals (`touchTerminal`). */
    terminalActiveAt: null as Date | null,
    outputReads: 0,
  };
  const shellHighWaters = options.shellHighWaters ?? [10n];
  const layer = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      listUnsettled: () =>
        Effect.sync(() => (state.session.settledAt === null ? [state.session] : [])),
      claimIdleStop: (_id, retryBefore) =>
        Effect.sync(() => {
          if (state.session.settledAt !== null) return false;
          if (state.idleStoppedAt !== null && state.idleStoppedAt >= retryBefore) return false;
          state.idleStoppedAt = new Date();
          return true;
        }),
      releaseIdleStop: () =>
        Effect.sync(() => {
          state.idleStoppedAt = null;
          state.released += 1;
        }),
      terminalActivity: () =>
        Effect.sync(
          () => new Map(state.terminalActiveAt === null ? [] : [[SESSION, state.terminalActiveAt]]),
        ),
    }),
    Layer.mock(WorktreesRepo, {
      byId: () =>
        Effect.succeed(
          new Worktree({
            id: WorktreeId.make("wt-1"),
            projectId: ProjectId.make("p-billing"),
            sessionRuntime: options.runtime === undefined ? "docker" : options.runtime,
            name: "wt-1",
            directory: "wt-1",
            branch: "mend/wt-1",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            handoff: null,
            createdAt: minutesAgo(60),
            updatedAt: minutesAgo(60),
          }),
        ),
    }),
    Layer.mock(SealantClient, {
      getWorkspace: () => Effect.succeed({} as never),
      getSession: () =>
        Effect.sync(() => {
          const highWater = shellHighWaters[state.outputReads] ?? shellHighWaters.at(-1) ?? null;
          state.outputReads += 1;
          return {
            status: () =>
              highWater === null
                ? Promise.reject(new Error("the platform did not answer"))
                : Promise.resolve({ status: "running", outputHighWater: highWater }),
          } as never;
        }),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: () => Effect.sync(() => state.processes),
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: () => Effect.succeed(options.turns ?? [turnRow("completed", 20)]),
      listRequests: () => Effect.succeed(options.requests ?? []),
      taskActivity: () =>
        Effect.succeed({
          running: options.runningTasks ?? 0,
          lastUpdatedAt:
            options.taskChangedMinutesAgo === undefined
              ? null
              : minutesAgo(options.taskChangedMinutesAgo),
        }),
    }),
    Layer.mock(ServicesRepo, {
      liveCountsForSessions: () =>
        Effect.succeed(
          new Map(
            options.liveServices === undefined ? [] : [[SESSION, options.liveServices] as const],
          ),
        ),
    }),
    Layer.effect(
      ScreensRepo,
      Effect.gen(function* () {
        const screens = makeScreensMemory();
        if (options.screen === undefined) return screens;
        const screen = yield* screens.reserve({
          sessionId: SESSION,
          workspaceId: SealantWorkspaceId.make("ws-1"),
        });
        yield* screens.setLife(screen.id, {
          life: { _tag: "Live", degraded: null, browserSandboxOff: false },
          processId: SessionProcessId.make("screen-1"),
        });
        if (options.screen.held) {
          const connection = ViewerConnectionId.make("viewer-1");
          yield* screens.control(screen.id, { _tag: "Take", by: "alice", connection }, "alice");
          yield* screens.control(screen.id, { _tag: "Fenced", epoch: 1 }, "alice");
        }
        return screens;
      }).pipe(Effect.orDie),
    ),
    Layer.mock(SessionControlEventsRepo, {
      record: (event) => Effect.sync(() => void state.control.push(event)),
    }),
    Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      stopScreen: (sessionId, reason) =>
        Effect.sync(() => void state.screenStops.push(`${sessionId} · ${reason}`)),
      readCaptures: () =>
        Effect.sync(() => {
          const answer = options.captures?.[state.captureReads] ?? options.captures?.at(-1) ?? null;
          state.captureReads += 1;
          return answer;
        }),
      stop: (sessionId, summary) =>
        options.stopFails === true
          ? Effect.die(new Error("the platform did not answer"))
          : Effect.sync(() => {
              state.stops.push({ sessionId, summary: summary ?? null });
              state.processes = state.processes.map((process) =>
                process.id === AGENT
                  ? new SessionProcess({ ...process, status: "stopped", exitedAt: new Date() })
                  : process,
              );
              state.session = new Session({
                ...sessionRow("stopped", new Date()),
                summary: summary ?? null,
                idleStoppedAt: state.idleStoppedAt,
              });
            }),
    }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        options.minutes === undefined ? {} : { MEND_PROTOCOL_IDLE_STOP_MINUTES: options.minutes },
      ),
    ),
  );
  const worker = () =>
    Effect.runSync(
      Effect.gen(function* () {
        return yield* ProtocolIdleStop;
      }).pipe(Effect.provide(ProtocolIdleStopLive.pipe(Layer.provide(layer)))),
    );
  return { state, worker, sweep };
};

/** What the executor answers when the idle stop reads its captures. */
const captureReading = (pending: number, bulkDirty: boolean | null = null): CaptureReading => ({
  pending,
  pendingBytes: null,
  pendingBulk: null,
  refused: null,
  headN: 4,
  registered: 4,
  uploadedBytes: 4000,
  fenced: false,
  paused: false,
  bulkDirty,
  // A reading's flush is the suspend kind: it says nothing about a final one.
  complete: null,
  incompleteReason: null,
  snapError: null,
  snapFailingSince: null,
  snapsFailed: null,
  unreadable: null,
  unreadablePaths: [],
});

describe("the protocol idle stop", () => {
  it("stops an idle protocol agent once across two workers and later sweeps", async () => {
    const w = world();
    const first = w.worker();
    const second = w.worker();

    const [a, b] = await Promise.all([w.sweep(first), w.sweep(second)]);
    await w.sweep(first);
    await w.sweep(second);

    expect([...a, ...b]).toEqual([SESSION]);
    expect(w.state.stops).toEqual([
      { sessionId: SESSION, summary: "idle · stopped after 15 min · reply to resume" },
    ]);
    expect(w.state.session.status).toBe("stopped");
    expect(w.state.session.summary).toBe("idle · stopped after 15 min · reply to resume");
    expect(w.state.session.idleStoppedAt).not.toBeNull();
    expect(w.state.control).toEqual([
      { sessionId: SESSION, actorUserId: "alice", kind: "idle-stop", refId: AGENT },
    ]);
  });

  it("words the summary with the configured minutes, and waits until they have passed", async () => {
    const early = world({ minutes: "30" });
    expect(await early.sweep(early.worker())).toEqual([]);

    const due = world({ minutes: "10" });
    expect(await due.sweep(due.worker())).toEqual([SESSION]);
    expect(due.state.stops[0]?.summary).toBe("idle · stopped after 10 min · reply to resume");
  });

  it("counts the minutes from when a workflow last changed, not from the turn that started it", async () => {
    // The turn ended 20 minutes ago; the workflow it started finished 5 minutes ago.
    const finished = world({ taskChangedMinutesAgo: 5 });
    expect(await finished.sweep(finished.worker())).toEqual([]);
    const long = world({ taskChangedMinutesAgo: 16 });
    expect(await long.sweep(long.worker())).toEqual([SESSION]);
  });

  it("never stops a session while its workflow runs, however long it has been quiet", async () => {
    const quiet = world({ runningTasks: 1, taskChangedMinutesAgo: 600 });
    expect(await quiet.sweep(quiet.worker())).toEqual([]);
    expect(quiet.state.stops).toEqual([]);
    expect(quiet.state.idleStoppedAt).toBeNull();
  });

  it("stops nothing at 0 minutes", async () => {
    const w = world({ minutes: "0" });
    expect(await w.sweep(w.worker())).toEqual([]);
    expect(w.state.stops).toEqual([]);
  });

  it("leaves an agent alone while a turn runs, a task runs, a request waits, or Services or a shell hold it", async () => {
    const held = [
      world({ turns: [turnRow("running", null)] }),
      world({ runningTasks: 1 }),
      world({ turns: [turnRow("queued", null)] }),
      world({ requests: [pendingRequest] }),
      world({ liveServices: 2 }),
      world({ shells: true }),
      world({ agentKind: "agent-pty" }),
    ];
    for (const w of held) {
      expect(await w.sweep(w.worker())).toEqual([]);
      expect(w.state.stops).toEqual([]);
      expect(w.state.idleStoppedAt).toBeNull();
    }
  });

  it("leaves an agent alone while a person holds its screen, and never stops a screen on its own", async () => {
    const held = world({ screen: { held: true } });
    expect(await held.sweep(held.worker())).toEqual([]);
    expect(held.state.screenStops).toEqual([]);

    // An idle agent stops with its screen, as Stop does; the pass stops no screen by itself.
    const idle = world({ screen: { held: false } });
    expect(await idle.sweep(idle.worker())).toEqual([SESSION]);
    expect(idle.state.screenStops).toEqual([]);

    const off = world({ minutes: "0", screen: { held: false } });
    expect(await off.sweep(off.worker())).toEqual([]);
    expect(off.state.screenStops).toEqual([]);
  });

  it("leaves an agent alone while its executor still ships captures, then stops it once they are in", async () => {
    const w = world({ captures: [captureReading(3), captureReading(0, true), captureReading(0)] });
    const worker = w.worker();
    expect(await w.sweep(worker)).toEqual([]);
    expect(w.state.stops).toEqual([]);
    expect(w.state.idleStoppedAt).toBeNull();
    // Bulk changed since its last snapshot (once sealantd reports it) holds it too.
    expect(await w.sweep(worker)).toEqual([]);
    expect(w.state.stops).toEqual([]);
    expect(await w.sweep(worker)).toEqual([SESSION]);
    expect(w.state.stops).toHaveLength(1);
    expect(w.state.captureReads).toBe(3);
  });

  it("gives the claim back when the stop fails, and records nothing", async () => {
    const w = world({ stopFails: true });
    expect(await w.sweep(w.worker())).toEqual([]);
    expect(w.state.released).toBe(1);
    expect(w.state.idleStoppedAt).toBeNull();
    expect(w.state.control).toEqual([]);
  });
});

it("the idle worker stops a screen wake with no agent or turn", async () => {
  const w = world({ turns: [] });
  w.state.processes = [
    new SessionProcess({
      ...processRow("shell", true),
      launchCorrelationId: workspaceWakeLaunchId("screen", "one"),
    }),
  ];
  expect(await w.sweep(w.worker())).toEqual([SESSION]);
  expect(w.state.session.status).toBe("stopped");
});

describe("an open shell in a conversation session on Boat", () => {
  it("stops a quiet shell tab with its idle session, counting from the shell's last signal", async () => {
    const w = world({ runtime: "boat", shells: true });
    const worker = w.worker();
    // First read now: the shell's output mark starts here.
    expect(await sweepAt(worker, 0)).toEqual([]);
    expect(await sweepAt(worker, 14)).toEqual([]);
    expect(await sweepAt(worker, 15)).toEqual([SESSION]);
    expect(w.state.stops).toEqual([
      { sessionId: SESSION, summary: "idle · stopped after 15 min · reply to resume" },
    ]);
  });

  it("holds while the shell prints, a client is on it, or the platform does not say what it printed", async () => {
    // Printing at every read until minute 10.
    const printing = world({ runtime: "boat", shells: true, shellHighWaters: [1n, 2n, 3n] });
    const a = printing.worker();
    await sweepAt(a, 0);
    await sweepAt(a, 5);
    await sweepAt(a, 10);
    expect(await sweepAt(a, 24)).toEqual([]);
    expect(await sweepAt(a, 25)).toEqual([SESSION]);

    // A client on the shell stamps the session every minute it stays.
    const attached = world({ runtime: "boat", shells: true });
    const b = attached.worker();
    for (const minute of [0, 15, 30, 60]) {
      attached.state.terminalActiveAt = new Date(Date.now() + minute * 60_000 - 30_000);
      expect(await sweepAt(b, minute)).toEqual([]);
    }

    const unread = world({ runtime: "boat", shells: true, shellHighWaters: [null] });
    const c = unread.worker();
    await sweepAt(c, 0);
    expect(await sweepAt(c, 60)).toEqual([]);
    expect(unread.state.stops).toEqual([]);
  });

  it("keeps Docker's rule: any open shell holds the stop, and its output is never read", async () => {
    for (const runtime of ["docker", null] as const) {
      const w = world({ runtime, shells: true });
      const worker = w.worker();
      await sweepAt(worker, 0);
      expect(await sweepAt(worker, 600)).toEqual([]);
      expect(w.state.stops).toEqual([]);
      expect(w.state.outputReads).toBe(0);
    }
  });
});
