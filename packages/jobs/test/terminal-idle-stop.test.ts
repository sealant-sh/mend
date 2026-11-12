import {
  makeScreensMemory,
  ScreensRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreesRepo,
  type NewSessionControlEvent,
} from "@mend/db";
import {
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  ViewerConnectionId,
  WorktreeId,
  type SessionRuntime,
} from "@mend/domain";
import {
  Session,
  SessionProcess,
  Worktree,
  type CaptureReading,
  type SessionProcessKind,
} from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { TerminalIdleStop, TerminalIdleStopLive } from "../src/terminal-idle-stop.ts";

const SESSION = SessionId.make("session-1");
const SHELL = SessionProcessId.make("shell-1");
const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000);

const sessionRow = (status: Session["status"], settledAt: Date | null) =>
  new Session({
    id: SESSION,
    projectId: ProjectId.make("p-billing"),
    worktreeId: WorktreeId.make("wt-1"),
    harness: "shell",
    providerSessionId: null,
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
    sealantSessionId: "pty-1",
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: "alice",
    origin: "mend",
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

const processRow = (kind: SessionProcessKind, id: string, updatedMinutesAgo = 60) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId: SESSION,
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: `pty-${id}`,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "shell" || kind === "service" ? null : "claude",
    providerSessionId: kind === "agent-protocol" ? "provider-1" : null,
    protocolOptions: null,
    label: kind,
    argv: [],
    status: "running",
    exitCode: null,
    workspacePort: kind === "service" ? 5432 : null,
    protocol: "tcp",
    hostPort: null,
    createdAt: minutesAgo(60),
    exitedAt: null,
    updatedAt: minutesAgo(updatedMinutesAgo),
  });

const worktreeRow = (runtime: SessionRuntime | null) =>
  new Worktree({
    id: WorktreeId.make("wt-1"),
    projectId: ProjectId.make("p-billing"),
    sessionRuntime: runtime,
    name: "wt-1",
    directory: "wt-1",
    branch: "mend/wt-1",
    baseSha: Sha.make("abc"),
    baseRef: "main",
    handoff: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  });

interface WorldOptions {
  readonly minutes?: string;
  readonly runtime?: SessionRuntime | null;
  /** The session's processes; a shell by default. */
  readonly processes?: ReadonlyArray<SessionProcess>;
  /** How much each terminal has printed, read by read; the last one repeats. null: no answer. */
  readonly highWaters?: ReadonlyArray<bigint | null>;
  /** The session's screen, live: whether a person holds its input. */
  readonly screen?: { readonly held: boolean };
  readonly captures?: ReadonlyArray<CaptureReading | null>;
}

/** The shared database and the platform as fakes, for one session; `stop` settles it as Stop does. */
const world = (options: WorldOptions = {}) => {
  const state = {
    session: sessionRow("running", null),
    idleStoppedAt: null as Date | null,
    processes: [
      ...(options.processes ?? [processRow("shell", "shell-1")]),
      ...(options.screen === undefined ? [] : [processRow("screen", "screen-1")]),
    ] as ReadonlyArray<SessionProcess>,
    stops: [] as Array<{ readonly sessionId: SessionId; readonly summary: string | null }>,
    control: [] as Array<NewSessionControlEvent>,
    /** When a client was last on one of the terminals (`touchTerminal`); a test moves it. */
    terminalActiveAt: null as Date | null,
    outputReads: 0,
    captureReads: 0,
  };
  const highWaters = options.highWaters ?? [10n];
  const layer = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      listUnsettled: () =>
        Effect.sync(() => (state.session.settledAt === null ? [state.session] : [])),
      terminalActivity: () =>
        Effect.sync(
          () => new Map(state.terminalActiveAt === null ? [] : [[SESSION, state.terminalActiveAt]]),
        ),
      claimIdleStop: (_id, retryBefore) =>
        Effect.sync(() => {
          if (state.session.settledAt !== null) return false;
          if (state.idleStoppedAt !== null && state.idleStoppedAt >= retryBefore) return false;
          state.idleStoppedAt = new Date();
          return true;
        }),
      releaseIdleStop: () => Effect.sync(() => void (state.idleStoppedAt = null)),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: () => Effect.sync(() => state.processes),
    }),
    Layer.mock(WorktreesRepo, {
      byId: () =>
        Effect.succeed(worktreeRow(options.runtime === undefined ? "boat" : options.runtime)),
    }),
    Layer.mock(SealantClient, {
      getWorkspace: () => Effect.succeed({} as never),
      getSession: () =>
        Effect.sync(() => {
          const highWater = highWaters[state.outputReads] ?? highWaters.at(-1) ?? null;
          state.outputReads += 1;
          return {
            status: () =>
              highWater === null
                ? Promise.reject(new Error("the platform did not answer"))
                : Promise.resolve({ status: "running", outputHighWater: highWater }),
          } as never;
        }),
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
      readCaptures: () =>
        Effect.sync(() => {
          const answer = options.captures?.[state.captureReads] ?? options.captures?.at(-1) ?? null;
          state.captureReads += 1;
          return answer;
        }),
      stop: (sessionId, summary) =>
        Effect.sync(() => {
          state.stops.push({ sessionId, summary: summary ?? null });
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
  const idle = Effect.runSync(
    Effect.gen(function* () {
      return yield* TerminalIdleStop;
    }).pipe(Effect.provide(TerminalIdleStopLive.pipe(Layer.provide(layer)))),
  );
  /** One pass, this many minutes from now. */
  const sweepAt = (minutesFromNow: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW + minutesFromNow * 60_000);
        return yield* idle.sweep();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  return { state, sweepAt };
};

const captureReading = (pending: number): CaptureReading => ({
  pending,
  pendingBytes: null,
  pendingBulk: null,
  refused: null,
  headN: 4,
  registered: 4,
  uploadedBytes: 4000,
  fenced: false,
  paused: false,
  bulkDirty: null,
  complete: null,
  incompleteReason: null,
  snapError: null,
  snapFailingSince: null,
  snapsFailed: null,
  unreadable: null,
  unreadablePaths: [],
});

const SUMMARY = "idle · stopped after 15 min · resume to continue";

describe("the terminal idle stop on Boat", () => {
  it("stops a terminal session nobody is on and that printed nothing for 15 minutes, as Stop does", async () => {
    const w = world();
    w.state.terminalActiveAt = minutesAgo(30);
    // First seen now: its output mark starts here, so nothing stops yet.
    expect(await w.sweepAt(0)).toEqual([]);
    expect(await w.sweepAt(14)).toEqual([]);
    expect(await w.sweepAt(15)).toEqual([SESSION]);
    expect(await w.sweepAt(16)).toEqual([]);
    expect(w.state.stops).toEqual([{ sessionId: SESSION, summary: SUMMARY }]);
    expect(w.state.session.status).toBe("stopped");
    expect(w.state.session.idleStoppedAt).not.toBeNull();
    expect(w.state.control).toEqual([
      { sessionId: SESSION, actorUserId: "alice", kind: "idle-stop", refId: SHELL },
    ]);
  });

  it("stops a terminal agent the same way", async () => {
    const w = world({ processes: [processRow("agent-pty", "agent-1")] });
    await w.sweepAt(0);
    expect(await w.sweepAt(15)).toEqual([SESSION]);
    expect(w.state.control[0]?.refId).toBe(SessionProcessId.make("agent-1"));
  });

  it("keeps a session up while its terminal prints, and counts from the last output", async () => {
    // A build printing at every read, then quiet from minute 10.
    const w = world({ highWaters: [10n, 20n, 30n] });
    expect(await w.sweepAt(0)).toEqual([]);
    expect(await w.sweepAt(5)).toEqual([]);
    expect(await w.sweepAt(10)).toEqual([]);
    expect(await w.sweepAt(20)).toEqual([]);
    expect(await w.sweepAt(24)).toEqual([]);
    expect(w.state.stops).toEqual([]);
    expect(await w.sweepAt(25)).toEqual([SESSION]);
  });

  it("keeps a session up while a client is on its terminal, and counts from when one typed or left", async () => {
    // An attached client stamps the session every minute it stays, watching or typing.
    const attached = world();
    for (const minute of [0, 15, 30, 60]) {
      attached.state.terminalActiveAt = new Date(NOW + minute * 60_000 - 30_000);
      expect(await attached.sweepAt(minute)).toEqual([]);
    }
    expect(attached.state.stops).toEqual([]);

    // Someone typed at minute 10 and left: the minutes count from there.
    const typed = world();
    await typed.sweepAt(0);
    typed.state.terminalActiveAt = new Date(NOW + 10 * 60_000);
    expect(await typed.sweepAt(15)).toEqual([]);
    expect(await typed.sweepAt(24)).toEqual([]);
    expect(await typed.sweepAt(25)).toEqual([SESSION]);
  });

  it("does not count containers, Services or background processes as activity", async () => {
    // A shell that ran `docker compose up -d` and went quiet: its database runs as a Service,
    // its row changed a minute ago, and the workspace is busy. None of it is a terminal signal.
    const w = world({
      processes: [processRow("shell", "shell-1", 1), processRow("service", "service-1", 1)],
    });
    await w.sweepAt(0);
    expect(await w.sweepAt(15)).toEqual([SESSION]);
    // The Service's output is never read: only the shell's terminal is.
    expect(w.state.outputReads).toBe(2);
  });

  it("holds while the platform does not say what a terminal printed", async () => {
    const w = world({ highWaters: [null] });
    await w.sweepAt(0);
    expect(await w.sweepAt(60)).toEqual([]);
    expect(w.state.stops).toEqual([]);
  });

  it("holds while a person holds the screen, or captures still ship", async () => {
    const held = world({ screen: { held: true } });
    await held.sweepAt(0);
    expect(await held.sweepAt(30)).toEqual([]);

    const shipping = world({ captures: [captureReading(3), captureReading(0)] });
    await shipping.sweepAt(0);
    expect(await shipping.sweepAt(15)).toEqual([]);
    expect(shipping.state.stops).toEqual([]);
    expect(await shipping.sweepAt(16)).toEqual([SESSION]);
  });

  it("never stops a terminal session on Docker, or one from before the runtime choice", async () => {
    for (const runtime of ["docker", null] as const) {
      const w = world({ runtime });
      await w.sweepAt(0);
      expect(await w.sweepAt(600)).toEqual([]);
      expect(w.state.stops).toEqual([]);
      expect(w.state.outputReads).toBe(0);
    }
  });

  it("leaves protocol agents to the protocol idle stop, and stops nothing at 0 minutes", async () => {
    const protocol = world({
      processes: [processRow("agent-protocol", "agent-1"), processRow("shell", "shell-1")],
    });
    await protocol.sweepAt(0);
    expect(await protocol.sweepAt(600)).toEqual([]);

    const off = world({ minutes: "0" });
    await off.sweepAt(0);
    expect(await off.sweepAt(600)).toEqual([]);
    expect(off.state.stops).toEqual([]);
  });

  it("words the summary with the configured minutes", async () => {
    const w = world({ minutes: "30" });
    await w.sweepAt(0);
    expect(await w.sweepAt(15)).toEqual([]);
    expect(await w.sweepAt(30)).toEqual([SESSION]);
    expect(w.state.stops[0]?.summary).toBe("idle · stopped after 30 min · resume to continue");
  });
});
