import {
  AgentConversationRepo,
  ServicesRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
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
  WorktreeId,
} from "@mend/domain";
import {
  AgentRequest,
  AgentTurn,
  Session,
  SessionProcess,
  type AgentTurnStatus,
  type SessionProcessKind,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
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
  readonly shells?: boolean;
  readonly agentKind?: SessionProcessKind;
  readonly stopFails?: boolean;
}

/** One pass of one worker. */
const sweep = (idle: ProtocolIdleStop["Service"]) => Effect.runPromise(idle.sweep());

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
    ] as ReadonlyArray<SessionProcess>,
    stops: [] as Array<{ readonly sessionId: SessionId; readonly summary: string | null }>,
    control: [] as Array<NewSessionControlEvent>,
    released: 0,
  };
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
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: () => Effect.sync(() => state.processes),
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: () => Effect.succeed(options.turns ?? [turnRow("completed", 20)]),
      listRequests: () => Effect.succeed(options.requests ?? []),
    }),
    Layer.mock(ServicesRepo, {
      liveCountsForSessions: () =>
        Effect.succeed(
          new Map(
            options.liveServices === undefined ? [] : [[SESSION, options.liveServices] as const],
          ),
        ),
    }),
    Layer.mock(SessionControlEventsRepo, {
      record: (event) => Effect.sync(() => void state.control.push(event)),
    }),
    Layer.mock(SessionEngine, {
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

  it("stops nothing at 0 minutes", async () => {
    const w = world({ minutes: "0" });
    expect(await w.sweep(w.worker())).toEqual([]);
    expect(w.state.stops).toEqual([]);
  });

  it("leaves an agent alone while a turn runs, a request waits, or Services or a shell hold it", async () => {
    const held = [
      world({ turns: [turnRow("running", null)] }),
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

  it("gives the claim back when the stop fails, and records nothing", async () => {
    const w = world({ stopFails: true });
    expect(await w.sweep(w.worker())).toEqual([]);
    expect(w.state.released).toBe(1);
    expect(w.state.idleStoppedAt).toBeNull();
    expect(w.state.control).toEqual([]);
  });
});
