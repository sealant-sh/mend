import { CodexAdapter } from "@mend/agent-protocol";
import {
  AgentConversationRepo,
  AgentControlJournalError,
  SessionProcessesRepo,
  SessionsRepo,
  SessionStoppingError,
} from "@mend/db";
import {
  AgentItemId,
  AgentTurnId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import { AgentItem, AgentTurn, SessionProcess } from "@mend/domain/workbench";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { InteractiveSession } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { describe, expect, vi } from "vitest";

import { ProtocolHost, ProtocolHostLive } from "../src/protocol-host.ts";
import { makeSteerStore } from "./support/steer-store.ts";

const now = () => new Date();
const sessionId = SessionId.make("session-1");
const processId = SessionProcessId.make("process-1");

const agentProcess = new SessionProcess({
  id: processId,
  sessionId,
  sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
  sealantSessionId: "sealant-session-1",
  sealantRunId: null,
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "agent-protocol",
  harness: "codex",
  providerSessionId: null,
  protocolOptions: null,
  label: "codex",
  argv: ["codex", "app-server"],
  status: "running",
  exitCode: null,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: now(),
  exitedAt: null,
  updatedAt: now(),
});

/** In-memory turns with the same claim semantics as the real repo: one running per process. */
const makeConversationWorld = () => {
  const turns = new Map<AgentTurnId, AgentTurn>();
  const update = (id: AgentTurnId, patch: Partial<AgentTurn>) => {
    const current = turns.get(id);
    if (current === undefined) throw new Error(`unknown turn ${id}`);
    const next = new AgentTurn({ ...current, ...patch });
    turns.set(id, next);
    return next;
  };
  let ordinal = 0;
  const seed = (input: string): AgentTurn => {
    const turn = new AgentTurn({
      id: AgentTurnId.make(`turn-${ordinal}`),
      sessionId,
      processId,
      ordinal: ordinal++,
      author: "user-1",
      input,
      status: "queued",
      providerTurnId: null,
      error: null,
      usage: null,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    });
    turns.set(turn.id, turn);
    return turn;
  };
  /**
   * What the repo's admission sees: `stopping` once an idle stop claimed the session (it refuses
   * the turn); `beforeAdmit` runs as the turn is admitted — what happens concurrently.
   */
  const admission: {
    stopping: boolean;
    journalFailure: boolean;
    beforeAdmit: Effect.Effect<void>;
    beforeHarnessTurn: Effect.Effect<void>;
    beforeComplete: Effect.Effect<void>;
    afterSteerAdmit: Effect.Effect<void>;
    beforeSteerQueue: Effect.Effect<void>;
  } = {
    stopping: false,
    journalFailure: false,
    beforeAdmit: Effect.void,
    beforeHarnessTurn: Effect.void,
    beforeComplete: Effect.void,
    afterSteerAdmit: Effect.void,
    beforeSteerQueue: Effect.void,
  };
  const requeued = Effect.runSync(Deferred.make<void>());
  const items = new Map<string, AgentItem>();
  const cancelSweeps: Array<AgentTurnId> = [];
  const steerStore = makeSteerStore(turns, () => admission.stopping);
  const layer = Layer.succeed(AgentConversationRepo, {
    ...steerStore,
    admitTurnSteer: (input) =>
      steerStore.admitTurnSteer(input).pipe(Effect.tap(() => admission.afterSteerAdmit)),
    queueTurnSteer: (id, onProcess, reason) =>
      Effect.suspend(() => admission.beforeSteerQueue).pipe(
        Effect.andThen(steerStore.queueTurnSteer(id, onProcess, reason)),
      ),
    recordProtocolControl: (id, control) =>
      admission.journalFailure
        ? Effect.fail(new AgentControlJournalError({ message: "journal unavailable", cause: null }))
        : steerStore.recordProtocolControl(id, control),
    listTurns: () => Effect.succeed([...turns.values()]),
    submitTurn: (_session, _process, input) =>
      admission.beforeAdmit.pipe(
        Effect.andThen(
          admission.stopping
            ? Effect.fail(new SessionStoppingError({ sessionId }))
            : Effect.sync(() => seed(input)),
        ),
      ),
    byTurnId: (id) => Effect.succeed(turns.get(id) ?? null),
    byLaunchCorrelation: () => Effect.succeed(null),
    byProviderTurnId: (_session, providerTurnId) =>
      Effect.succeed(
        [...turns.values()].find((turn) => turn.providerTurnId === providerTurnId) ?? null,
      ),
    openTurns: () =>
      Effect.succeed(
        [...turns.values()].filter((turn) => turn.status === "queued" || turn.status === "running"),
      ),
    claimNextTurn: (onProcess) =>
      Effect.sync(() => {
        const all = [...turns.values()]
          .filter((row) => row.processId === onProcess)
          .toSorted((a, b) => a.ordinal - b.ordinal);
        if (all.some((turn) => turn.status === "running")) return null;
        const queued = all.find((turn) => turn.status === "queued");
        return queued === undefined
          ? null
          : update(queued.id, { status: "running", startedAt: now() });
      }),
    openHarnessTurn: (_session, _process, providerTurnId, reason, payer) =>
      admission.beforeHarnessTurn.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const all = [...turns.values()];
            const existing = all.find((turn) => turn.providerTurnId === providerTurnId);
            if (existing !== undefined) return existing;
            for (const turn of all) {
              if (turn.status === "running" && turn.providerTurnId === null) {
                update(turn.id, { status: "queued", startedAt: null });
              }
            }
            if ([...turns.values()].some((turn) => turn.status === "running")) return null;
            const turn = new AgentTurn({
              id: AgentTurnId.make(`turn-${ordinal}`),
              sessionId,
              processId,
              ordinal: ordinal++,
              author: null,
              origin: "harness",
              input: reason,
              status: "running",
              providerTurnId,
              error: null,
              usage: null,
              billedUserId: payer.userId,
              billedAccountId: payer.accountId,
              billedAccountName: payer.accountName,
              createdAt: now(),
              startedAt: now(),
              endedAt: null,
            });
            turns.set(turn.id, turn);
            return turn;
          }),
        ),
      ),
    requeueClaimedTurn: (id) =>
      Effect.sync(() => {
        const turn = turns.get(id);
        if (turn?.status === "running" && turn.providerTurnId === null) {
          update(id, { status: "queued", startedAt: null });
        }
      }).pipe(Effect.andThen(Deferred.succeed(requeued, undefined)), Effect.asVoid),
    setProviderTurnId: (id, providerTurnId) => Effect.sync(() => update(id, { providerTurnId })),
    setTurnPayer: (id, payer) =>
      Effect.sync(() =>
        update(id, {
          billedUserId: payer.userId,
          billedAccountId: payer.accountId,
          billedAccountName: payer.accountName,
        }),
      ),
    bindRunningProviderTurn: () => Effect.succeed(null),
    failTurn: (id, error) =>
      Effect.sync(() => update(id, { status: "failed", error, endedAt: now() })),
    setTurnIntent: () => Effect.die("not in test"),
    claimTurnLanding: () => Effect.die("not in test"),
    decideTurnLanding: () => Effect.die("not in test"),
    completeTurn: (providerTurnId, _session, status, usage, error) =>
      admission.beforeComplete.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const turn = [...turns.values()].find(
              (candidate) => candidate.providerTurnId === providerTurnId,
            );
            return turn === undefined
              ? null
              : update(turn.id, { status, usage, error, endedAt: now() });
          }),
        ),
      ),
    upsertItem: (input) =>
      Effect.sync(() => {
        const item = new AgentItem({
          id: AgentItemId.make(input.providerItemId),
          sessionId: input.sessionId,
          processId: input.processId,
          turnId: input.turnId,
          seq: items.size,
          providerItemId: input.providerItemId,
          kind: input.kind,
          status: input.status,
          title: input.title,
          text: input.text,
          data: input.data,
          createdAt: now(),
          updatedAt: now(),
        });
        items.set(input.providerItemId, item);
        return item;
      }),
    listItems: () => Effect.succeed([]),
    turnMessages: () => Effect.succeed([]),
    turnItems: () => Effect.succeed([]),
    openRequest: () => Effect.die("not in test"),
    byRequestId: () => Effect.succeed(null),
    listRequests: () => Effect.succeed([]),
    hasPendingRequests: () => Effect.succeed(false),
    taskActivity: () => Effect.succeed({ running: 0, lastUpdatedAt: null }),
    prepareRequestResponse: () => Effect.die("not in test"),
    completeRequestResponse: () => Effect.die("not in test"),
    failRequestResponse: () => Effect.void,
    resolveRequest: () => Effect.die("not in test"),
    resolveProviderRequest: () => Effect.void,
    cancelOpenForTurn: (turnId) =>
      Effect.sync(() => {
        cancelSweeps.push(turnId);
        const turn = turns.get(turnId);
        if (turn !== undefined && turn.status === "queued") {
          update(turnId, { status: "cancelled", endedAt: now() });
        }
      }),
    cancelOpenForProcess: () => Effect.void,
    protocolCursor: () => Effect.succeed({ nextSequence: 0n }),
    backfillConversation: () => Effect.succeed(0),
    resetSendingResponses: () => Effect.void,
    requeueQueuedTurns: () => Effect.void,
    saveProtocolCursor: () => Effect.void,
  });
  return { layer, turns, items, seed, admission, steerStore, requeued, cancelSweeps };
};

const processesLayer = (rows: ReadonlyArray<SessionProcess> = [agentProcess]) =>
  Layer.succeed(SessionProcessesRepo, {
    create: () => Effect.die("not in test"),
    byId: (id) => Effect.succeed(rows.find((row) => row.id === id) ?? null),
    byLaunchCorrelation: () => Effect.succeed(null),
    listForSession: () => Effect.succeed(rows),
    listForSessions: () => Effect.succeed(rows),
    listForService: () => Effect.succeed([]),
    listLiveForWorkspace: () => Effect.succeed([]),
    listLive: () => Effect.succeed([]),
    listRecentServices: () => Effect.succeed([]),
    setStatus: () => Effect.void,
    setLabel: () => Effect.void,
    setProviderSessionId: () => Effect.void,
    markFirstOutput: () => Effect.succeed(false),
    markReached: () => Effect.void,
    reached: () => Effect.succeed(false),
    setHostPort: () => Effect.void,
    setSealantSessionId: () => Effect.void,
    claimProviderSessionId: () => Effect.die("not in test"),
    setWaiting: () => Effect.die("not in test"),
    markExited: () => Effect.die("not in test"),
    reapLiveForWorkspace: () => Effect.succeed([]),
  });

/** Only setProviderSessionId is reachable from the host; everything else dies loudly. */
const sessionsLayer = Layer.succeed(SessionsRepo, {
  create: () => Effect.die("not in test"),
  byId: () => Effect.die("not in test"),
  listForProject: () => Effect.succeed([]),
  listForWorktree: () => Effect.succeed([]),
  listActive: () => Effect.succeed([]),
  liveMarkNow: () => Effect.succeed(0),
  listActiveView: () => Effect.succeed([]),
  listForProjectView: () => Effect.die("not in test"),
  viewById: () => Effect.die("not in test"),
  listUnsettled: () => Effect.succeed([]),
  setSharedControl: () => Effect.die("not in test"),
  disableSharedControlForOwner: () => Effect.succeed([]),
  listUnsettledForOwner: () => Effect.succeed([]),
  countUnsettledForOrganization: () => Effect.succeed(0),
  recentOwnersForProject: () => Effect.succeed([]),
  listRecentlySettled: () => Effect.succeed([]),
  setSealantIds: () => Effect.die("not in test"),
  recordWorkspaceTtlRenewal: () => Effect.void,
  recordWorkspaceTtlRenewalFailure: () => Effect.void,
  setSealantSessionId: () => Effect.void,
  setWorkspaceImage: () => Effect.void,
  setDotfiles: () => Effect.void,
  setHasTranscript: () => Effect.die("not in test"),
  listSettledUnclassified: () => Effect.succeed([]),
  setProviderSessionId: () => Effect.void,
  setReferenceMounts: () => Effect.void,
  setExtraMounts: () => Effect.void,
  setStatus: () => Effect.void,
  nativeIngestCursor: () => Effect.succeed(null),
  setNativeIngestCursor: () => Effect.void,
  saveLastSeenSequence: () => Effect.void,
  notifyProgress: () => Effect.void,
  settle: () => Effect.die("not in test"),
  reopen: () => Effect.succeed(false),
  claimIdleStop: () => Effect.succeed(false),
  releaseIdleStop: () => Effect.void,
  setSummary: () => Effect.void,
  restate: () => Effect.void,
  setLabel: () => Effect.void,
  setLabelIfUnset: () => Effect.succeed(false),
  remove: () => Effect.die("not in test"),
  setHarness: () => Effect.void,
  setLaunchOptions: () => Effect.void,
  recordCaptureObservation: () => Effect.void,
  beginCaptureDrain: () => Effect.void,
  planRelaunch: () => Effect.succeed("written"),
  swapRelaunch: () => Effect.succeed("written"),
  clearRelaunch: () => Effect.void,
  stopCaptureDrain: () => Effect.void,
  relaunchOf: () => Effect.succeed(null),
  markFinalFlush: () => Effect.void,
  finalFlushedWorkspace: () => Effect.succeed(null),
  recordCaptureSaved: () => Effect.void,
  captureSavedOf: () => Effect.succeed(null),
  recordCaptureUnsaved: () => Effect.void,
  captureUnsavedOf: () => Effect.succeed(null),
  recordExecutorEvidence: () => Effect.succeed(0),
  executorEvidenceOf: () => Effect.succeed(null),
  openEvidenceFence: () => Effect.succeed(0),
  closeEvidenceFence: () => Effect.void,
  evidenceFenced: () => Effect.succeed(false),
  publishExecutorReading: () => Effect.succeed(0),
  captureObservedPositionOf: () => Effect.succeed(null),
  recordCaptureDrainProgress: () => Effect.void,
  markCaptureNotSaved: () => Effect.succeed(false),
  endCaptureDrain: () => Effect.void,
  listCaptureDrains: () => Effect.succeed([]),
  setExecutorStartedAt: () => Effect.void,
  recordAcceptedWorkspace: () => Effect.void,
  recordExecutorResource: () => Effect.void,
  recordExecutorCreate: () => Effect.void,
  clearExecutorCreate: () => Effect.void,
  executorCreateOf: () => Effect.succeed(null),
  listExecutorCreates: () => Effect.succeed([]),
  executorResourceOf: () => Effect.succeed(null),
  executorLaunchOf: () => Effect.succeed(null),
  executorSessionOf: () => Effect.succeed(null),
  launchersOf: () => Effect.succeed(new Map()),
  executorAccessOf: () => Effect.succeed(null),
  requestRemoval: () => Effect.void,
  listRemovalRequested: () => Effect.succeed([]),
});

/**
 * A scripted codex app-server on the far side of a pipe session: answers the handshake, then
 * follows `turnScript` for each `turn/start` (an error entry rejects the turn, a string accepts
 * it with that provider turn id). Records every interrupt it receives.
 */
const PeerRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      turnId: Schema.optionalKey(Schema.String),
      expectedTurnId: Schema.optionalKey(Schema.String),
      input: Schema.optionalKey(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
      ),
    }),
  ),
});
type PeerRequest = typeof PeerRequest.Type;

const makePipe = (
  turnScript: Array<{ error: string } | string>,
  controls: {
    readonly steer?: (request: PeerRequest, push: (frame: unknown) => void) => Promise<void>;
    readonly start?: (
      request: PeerRequest,
      push: (frame: unknown) => void,
      pushRaw: (text: string) => void,
    ) => Promise<void>;
  } = {},
) => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const interrupted: string[] = [];
  const written: Array<PeerRequest> = [];
  /** One output chunk carrying exactly these bytes, so a record can end mid-line. */
  const pushRaw = (text: string) => {
    pending.push({ sequence: sequence++, data: new TextEncoder().encode(text) });
    notify?.();
  };
  const push = (value: unknown) => pushRaw(`${JSON.stringify(value)}\n`);
  let turnIndex = 0;
  const pipe: InteractiveSession = {
    id: "sealant-session-1",
    workspaceId: "ws-1",
    runId: "run-1",
    mode: "pipe",
    send: (input) => {
      const text = typeof input === "string" ? input : new TextDecoder().decode(input);
      const message: unknown = JSON.parse(text);
      if (typeof message !== "object" || message === null) return Promise.resolve();
      const request = Schema.decodeUnknownSync(PeerRequest)(message);
      written.push(request);
      if (request.id === undefined) return Promise.resolve();
      switch (request.method) {
        case "initialize":
          push({ id: request.id, result: {} });
          break;
        case "thread/start":
        case "thread/resume":
          push({ id: request.id, result: { thread: { id: "thread-1" } } });
          break;
        case "turn/start": {
          if (controls.start !== undefined) return controls.start(request, push, pushRaw);
          const step = turnScript[turnIndex++] ?? "turn-fallback";
          if (typeof step === "string") push({ id: request.id, result: { turn: { id: step } } });
          else push({ id: request.id, error: { message: step.error } });
          break;
        }
        case "turn/steer":
          if (controls.steer !== undefined) return controls.steer(request, push);
          push({ id: request.id, result: { turnId: request.params?.expectedTurnId } });
          break;
        case "turn/interrupt":
          interrupted.push(request.params?.turnId ?? "unknown");
          push({ id: request.id, result: {} });
          break;
        default:
          push({ id: request.id, result: {} });
      }
      return Promise.resolve();
    },
    output: (options) => {
      const signal = options?.signal;
      return (async function* () {
        for (;;) {
          if (signal?.aborted === true) return;
          const next = pending.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
            // A push that landed between the empty shift and this arm must not
            // sleep forever — with one exchange in flight there is no later
            // push to recover the lost wakeup.
            if (pending.length > 0) resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          notify = null;
        }
      })();
    },
    resize: () => Promise.reject(new Error("pipe sessions have no terminal")),
    signal: () => Promise.resolve(),
    status: () => Promise.reject(new Error("not in test")),
    close: () => Promise.resolve(),
    attach: () => Promise.reject(new Error("not in test")),
  };
  return { pipe, interrupted, written, push, pushRaw };
};

/** A Claude Code on the far side of a pipe: records what Mend sends, says what the test pushes. */
const makeClaudePipe = () => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const sent: Array<string> = [];
  const pushRaw = (text: string) => {
    pending.push({ sequence: sequence++, data: new TextEncoder().encode(text) });
    notify?.();
  };
  const push = (value: unknown) => pushRaw(`${JSON.stringify(value)}\n`);
  const pipe: InteractiveSession = {
    id: "sealant-session-1",
    workspaceId: "ws-1",
    runId: "run-1",
    mode: "pipe",
    send: (input) => {
      sent.push(typeof input === "string" ? input : new TextDecoder().decode(input));
      return Promise.resolve();
    },
    output: (options) => {
      const signal = options?.signal;
      return (async function* () {
        for (;;) {
          if (signal?.aborted === true) return;
          const next = pending.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
            if (pending.length > 0) resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          notify = null;
        }
      })();
    },
    resize: () => Promise.reject(new Error("pipe sessions have no terminal")),
    signal: () => Promise.resolve(),
    status: () => Promise.reject(new Error("not in test")),
    close: () => Promise.resolve(),
    attach: () => Promise.reject(new Error("not in test")),
  };
  return { pipe, push, pushRaw, sent };
};

const hostLayer = (
  conversation: Layer.Layer<AgentConversationRepo>,
  rows?: ReadonlyArray<SessionProcess>,
) =>
  ProtocolHostLive.pipe(
    Layer.provide(conversation),
    Layer.provide(processesLayer(rows)),
    Layer.provide(sessionsLayer),
  );

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
    expect.fail("condition never became true");
  });

describe("ProtocolHost", () => {
  it.effect("keeps dispatching queued turns past a rejected one", () => {
    const world = makeConversationWorld();
    const first = world.seed("first");
    const second = world.seed("second");
    const { pipe } = makePipe([{ error: "model unavailable" }, "turn-accepted"]);
    const completed: string[] = [];
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* host.attach({
        process: agentProcess,
        pipe,
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        launchedWithLoginOf: "owner-1",
        hooks: {
          onRequestChanged: () => Effect.void,
          onTurnCompleted: (turn) => Effect.sync(() => void completed.push(turn.id)),
        },
      });
      yield* waitUntil(() => world.turns.get(second.id)?.providerTurnId === "turn-accepted");
      expect(world.turns.get(first.id)?.status).toBe("failed");
      expect(world.turns.get(first.id)?.error).toContain("model unavailable");
      expect(world.turns.get(second.id)?.status).toBe("running");
      expect(completed).toEqual([first.id]);
      expect(world.turns.get(second.id)).toMatchObject({
        author: "user-1",
        billedUserId: "owner-1",
        billedAccountId: null,
        billedAccountName: null,
      });
      expect(world.turns.get(first.id)?.billedUserId).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  // Live clock: the rehydrate gate watcher sleeps between catch-up polls.
  it.live(
    "rehydrates a surviving pipe: orphans fail, the gate opens, queued turns dispatch",
    () => {
      const world = makeConversationWorld();
      const done = world.seed("earlier");
      world.turns.set(
        done.id,
        new AgentTurn({ ...done, status: "completed", providerTurnId: "turn-a" }),
      );
      const orphan = world.seed("orphan");
      world.turns.set(orphan.id, new AgentTurn({ ...orphan, status: "running" }));
      const queued = world.seed("queued");
      const { pipe } = makePipe(["turn-b"]);
      const completed: string[] = [];
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        const input = {
          // Rehydrate addresses the surviving thread by its durable id.
          process: new SessionProcess({ ...agentProcess, providerSessionId: "thread-1" }),
          pipe,
          cwd: "/workspace/repo",
          permissionMode: "bypass" as const,
          // Mend cannot say whose workspace it is: the turns it sends say no payer.
          launchedWithLoginOf: null,
          hooks: {
            onRequestChanged: () => Effect.void,
            onTurnCompleted: (turn: AgentTurn) => Effect.sync(() => void completed.push(turn.id)),
          },
          highWater: 0n,
        };
        yield* host.rehydrate(input);
        // A turn dispatched but never acknowledged cannot be correlated with the
        // replay — failed honestly, and the completion hook heard about it.
        expect(world.turns.get(orphan.id)?.status).toBe("failed");
        expect(world.turns.get(orphan.id)?.error).toContain(
          "restarted before the turn was acknowledged",
        );
        expect(completed).toEqual([orphan.id]);
        // Replay is already at the high water (nothing recorded): the gate opens
        // and the queued turn reaches the surviving harness.
        yield* waitUntil(() => world.turns.get(queued.id)?.providerTurnId === "turn-b");
        expect(world.turns.get(queued.id)?.status).toBe("running");
        expect(world.turns.get(queued.id)).toMatchObject({
          billedUserId: null,
          billedAccountName: null,
        });
        // A second rehydrate of a hosted process is a no-op.
        yield* host.rehydrate(input);
        expect(yield* host.has(processId)).toBe(true);
        // Release the pipe generator before scope close: the live-clock teardown
        // otherwise waits on its never-resolving next().
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect(
    "never acknowledges a turn once stopping began: a claimed idle stop refuses it, and a host detached meanwhile cancels it",
    () => {
      const world = makeConversationWorld();
      const { pipe } = makePipe([]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* host.attach({
          process: agentProcess,
          pipe,
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          launchedWithLoginOf: "owner-1",
          hooks: {
            onRequestChanged: () => Effect.void,
            onTurnCompleted: () => Effect.void,
          },
        });
        // The host was live when the submission read it; the idle stop claimed the session
        // before the turn was admitted.
        world.admission.stopping = true;
        const refused = yield* host
          .submitTurn(sessionId, "one more thing", "user-1")
          .pipe(Effect.flip);
        expect(refused._tag).toBe("ProtocolHostNotLiveError");
        expect(world.turns.size).toBe(0);
        // A stop that detaches the host while the turn is being admitted: the turn is cancelled
        // and the submission refused, never left queued against a stopped process.
        world.admission.stopping = false;
        world.admission.beforeAdmit = host.detach(processId);
        const detached = yield* host.submitTurn(sessionId, "and this", "user-1").pipe(Effect.flip);
        expect(detached._tag).toBe("ProtocolHostNotLiveError");
        expect([...world.turns.values()].map((turn) => turn.status)).toEqual(["cancelled"]);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.live(
    "records a workflow after its turn ended, and the turn Claude opens when it finishes",
    () => {
      const world = makeConversationWorld();
      const asked = world.seed("run the workflow");
      const claude = makeClaudePipe();
      const gate = Effect.runSync(Deferred.make<void>());
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* host.attach({
          process: new SessionProcess({ ...agentProcess, harness: "claude", label: "claude" }),
          pipe: claude.pipe,
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          launchedWithLoginOf: "owner-1",
          hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
        });
        yield* waitUntil(() => world.turns.get(asked.id)?.providerTurnId !== null);
        claude.push({ type: "system", subtype: "init", uuid: "init-1" });
        claude.push({
          type: "system",
          subtype: "task_started",
          task_id: "wf1",
          task_type: "local_workflow",
          workflow_name: "tiny",
          description: "two tiny agents",
        });
        claude.push({ type: "result", subtype: "success" });
        yield* waitUntil(() => world.turns.get(asked.id)?.status === "completed");

        // The workflow ends after its turn did: the task still reports on that turn.
        claude.push({
          type: "system",
          subtype: "task_notification",
          task_id: "wf1",
          status: "completed",
          summary: 'Dynamic workflow "two tiny agents" completed',
        });
        yield* waitUntil(() => world.items.get("task:wf1")?.status === "completed");
        expect(world.items.get("task:wf1")?.turnId).toBe(asked.id);

        // Claude opens a turn of its own; a message sent in the same moment is claimed before
        // the record holds that turn, refused by the adapter, and queued again.
        world.admission.beforeHarnessTurn = Deferred.await(gate);
        claude.push({ type: "system", subtype: "init", uuid: "init-2" });
        yield* Effect.sleep("30 millis");
        const userLines = () => claude.sent.filter((line) => line.includes('"type":"user"'));
        const next = yield* host.submitTurn(sessionId, "and now this", "user-1");
        // Dispatch ran inside the submission: claimed, refused, and back in the queue unsent.
        expect(world.turns.get(next.id)).toMatchObject({ status: "queued", startedAt: null });
        expect(userLines()).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
        const harness = () =>
          [...world.turns.values()].find((turn) => turn.providerTurnId === "harness:init-2");
        yield* waitUntil(() => harness()?.status === "running");
        expect(harness()).toMatchObject({
          origin: "harness",
          author: null,
          input: 'Dynamic workflow "two tiny agents" completed',
          // Nobody sent it; it ran on the login the workspace holds.
          billedUserId: "owner-1",
          billedAccountName: null,
        });
        claude.push({
          type: "assistant",
          message: { id: "msg_3", content: [{ type: "text", text: "Results: pelican" }] },
        });
        claude.push({ type: "result", subtype: "success" });

        // The harness turn ended: the queued message goes out, once.
        yield* waitUntil(() => world.turns.get(next.id)?.providerTurnId !== null);
        expect(harness()?.status).toBe("completed");
        expect(world.items.get("msg_3:block:0")?.turnId).toBe(harness()?.id);
        expect(userLines()).toHaveLength(2);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("interrupts only the turn it was asked to interrupt", () => {
    const world = makeConversationWorld();
    const running = world.seed("running");
    const { pipe, interrupted } = makePipe(["turn-running"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* host.attach({
        process: agentProcess,
        pipe,
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        launchedWithLoginOf: "owner-1",
        hooks: {
          onRequestChanged: () => Effect.void,
          onTurnCompleted: () => Effect.void,
        },
      });
      yield* waitUntil(() => world.turns.get(running.id)?.providerTurnId === "turn-running");
      const queued = world.seed("queued behind");

      // A queued turn cancels its row; the harness never hears about it.
      yield* host.interruptTurn(queued.id);
      expect(world.turns.get(queued.id)?.status).toBe("cancelled");
      expect(interrupted).toEqual([]);

      // The running turn reaches the harness.
      yield* host.interruptTurn(running.id);
      yield* waitUntil(() => interrupted.length === 1);
      expect(interrupted).toEqual(["turn-running"]);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });
  const attachCodex = (host: ProtocolHost["Service"], pipe: InteractiveSession) =>
    host.attach({
      process: agentProcess,
      pipe,
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: "owner-1",
      hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
    });
  const rehydrateCodex = (
    host: ProtocolHost["Service"],
    pipe: InteractiveSession,
    highWater: bigint,
  ) =>
    host.rehydrate({
      process: new SessionProcess({ ...agentProcess, providerSessionId: "thread-1" }),
      pipe,
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: "owner-1",
      hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
      highWater,
    });

  it.live("dispatches a rehydrated session that never steers behind a partial final record", () => {
    const world = makeConversationWorld();
    const queued = world.seed("queued");
    const peer = makePipe([], {
      start: (request, push, pushRaw) => {
        pushRaw('ore-restart","result":{}}\n');
        push({ id: request.id, result: { turn: { id: "turn-b" } } });
        return Promise.resolve();
      },
    });
    peer.push({ id: "earlier", result: {} });
    peer.pushRaw('{"id":"bef');
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* rehydrateCodex(host, peer.pipe, 1n);
      yield* waitUntil(() => world.turns.get(queued.id)?.providerTurnId === "turn-b");
      expect(world.turns.get(queued.id)?.status).toBe("running");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  const startedA = JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-a" } },
  });
  const completedA = JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-a", status: "completed" } },
  });
  const half = Math.floor(completedA.length / 2);
  const replays = [
    {
      name: "a record split across chunks",
      recorded: completedA.slice(0, half),
      rest: `${completedA.slice(half)}\n`,
    },
    {
      name: "a partial tail",
      recorded: `${startedA}\n${completedA.slice(0, half)}`,
      rest: `${completedA.slice(half)}\n`,
    },
    { name: "a delayed projection", recorded: `${startedA}\n${completedA}\n`, rest: null },
  ];
  for (const replay of replays) {
    it.live(`admits a rehydrated steer only after ${replay.name} is projected`, () => {
      const world = makeConversationWorld();
      const target = world.seed("target");
      world.turns.set(
        target.id,
        new AgentTurn({ ...target, status: "running", providerTurnId: "turn-a", startedAt: now() }),
      );
      const projected = Effect.runSync(Deferred.make<void>());
      if (replay.rest === null) world.admission.beforeComplete = Deferred.await(projected);
      const peer = makePipe(["fallback"]);
      const steerFrames = () => peer.written.filter((request) => request.method === "turn/steer");
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* rehydrateCodex(host, peer.pipe, 0n);
        peer.pushRaw(replay.recorded);
        const steering = yield* host
          .steerTurn({ turnId: target.id, sender: "user-1", input: "after replay" })
          .pipe(Effect.forkChild);
        yield* Effect.sleep("300 millis");
        expect(steerFrames()).toEqual([]);
        const saved = (yield* world.steerStore.listConversationTurns(sessionId)).flatMap(
          (turn) => turn.steers,
        );
        expect(saved.map((steer) => steer.delivery)).toEqual([{ _tag: "Sending" }]);
        if (replay.rest === null) yield* Deferred.succeed(projected, undefined);
        else peer.pushRaw(replay.rest);
        const receipt = yield* Fiber.join(steering);
        expect(receipt.delivery).toEqual({
          _tag: "Queued",
          turnId: receipt.queuedTurnId,
          reason: "turn-ended",
        });
        expect(world.turns.get(target.id)?.status).toBe("completed");
        expect(steerFrames()).toEqual([]);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    });
  }

  it.live("carries words for an ended turn at once while a partial tail holds steers", () => {
    const world = makeConversationWorld();
    const ended = world.seed("ended");
    world.turns.set(
      ended.id,
      new AgentTurn({ ...ended, status: "completed", providerTurnId: "turn-a", endedAt: now() }),
    );
    const queued = world.seed("queued");
    const peer = makePipe([], { start: () => Promise.resolve() });
    peer.push({ id: "earlier", result: {} });
    peer.pushRaw('{"id":"bef');
    const starts = () => peer.written.filter((request) => request.method === "turn/start");
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* rehydrateCodex(host, peer.pipe, 1n);
      const steering = yield* host
        .steerTurn({ turnId: ended.id, sender: "user-1", input: "after it ended" })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => starts().length === 1);
      expect(world.turns.get(queued.id)?.status).toBe("running");
      const receipt = yield* Fiber.join(steering).pipe(Effect.timeout("1 second"));
      expect(receipt.delivery).toEqual({
        _tag: "Queued",
        turnId: receipt.queuedTurnId,
        reason: "turn-ended",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("queues a steer whose rehydrated process never finishes its last record", () => {
    const world = makeConversationWorld();
    const target = world.seed("target");
    world.turns.set(
      target.id,
      new AgentTurn({ ...target, status: "running", providerTurnId: "turn-a", startedAt: now() }),
    );
    const peer = makePipe([]);
    peer.push({ id: "earlier", result: {} });
    peer.pushRaw('{"id":"bef');
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* rehydrateCodex(host, peer.pipe, 1n);
      const steering = yield* host
        .steerTurn({ turnId: target.id, sender: "user-1", input: "while replaying" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const receipt = yield* Fiber.join(steering);
      expect(receipt.delivery).toEqual({
        _tag: "Queued",
        turnId: receipt.queuedTurnId,
        reason: "replaying",
      });
      expect(peer.written.filter((request) => request.method === "turn/steer")).toEqual([]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect(
    "saves exact steer text, acknowledges the expected turn, and deduplicates retries",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makePipe(["native"]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const input = {
          turnId: turn.id,
          sender: "user-1",
          input: "  keep this\n",
          clientSteerId: crypto.randomUUID(),
        };
        const receipt = yield* host.steerTurn(input);
        expect(receipt.delivery).toEqual({ _tag: "Accepted", evidence: "provider-acknowledged" });
        expect(receipt.input).toBe(input.input);
        expect(yield* host.steerTurn({ ...input })).toEqual(receipt);
        const steers = peer.written.filter((frame) => frame.method === "turn/steer");
        expect(steers).toHaveLength(1);
        expect(steers[0]?.params).toEqual({
          expectedTurnId: "native",
          input: [{ type: "text", text: input.input }],
        });
        expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
        expect(world.turns.get(turn.id)).toMatchObject({
          status: "running",
          billedUserId: "owner-1",
          input: "start",
        });
        yield* host.detach(processId);
        expect(yield* host.steerTurn(input)).toEqual(receipt);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  for (const [message, code, reason] of [
    ["no active turn to steer", -32600, "no-active-turn"],
    ["expected active turn id `native` but found `new`", -32600, "target-changed"],
    ["cannot steer a review turn", -32600, "review-turn"],
    ["cannot steer a compact turn", -32600, "compact-turn"],
    ["active turn uses a different output schema", -32600, "output-schema"],
    ["input must not be empty", -32600, "invalid-input"],
    ["Server is draining; retry after reconnecting", -32600, "server-draining"],
    ["Method not found", -32601, "unsupported"],
  ] as const)
    it.effect(`queues a definite ${reason} refusal exactly once`, () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makePipe(["native"], {
        steer: (request, push) => {
          push({ id: request.id, error: { code, message } });
          return Promise.resolve();
        },
      });
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const input = {
          turnId: turn.id,
          sender: "user-1",
          input: "next words",
          clientSteerId: crypto.randomUUID(),
        };
        const receipt = yield* host.steerTurn(input);
        expect(receipt.delivery).toEqual({ _tag: "Queued", turnId: receipt.queuedTurnId, reason });
        expect(world.turns.get(receipt.queuedTurnId ?? turn.id)).toMatchObject({
          input: input.input,
          author: input.sender,
          status: "queued",
        });
        expect(yield* host.steerTurn(input)).toEqual(receipt);
        expect(world.turns.size).toBe(2);
        expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(1);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    });

  for (const status of ["queued", "completed", "interrupted", "failed", "cancelled"] as const)
    it.effect(`carries words targeting a ${status} turn without steering another turn`, () => {
      const world = makeConversationWorld();
      world.seed("running");
      const target = world.seed("older");
      world.turns.set(target.id, new AgentTurn({ ...target, status }));
      const peer = makePipe(["native"]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const receipt = yield* host.steerTurn({
          turnId: target.id,
          input: "keep me",
          sender: "user-1",
        });
        expect(receipt.delivery).toEqual({
          _tag: "Queued",
          turnId: receipt.queuedTurnId,
          reason: status === "queued" ? "not-running" : "turn-ended",
        });
        expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(0);
        expect(world.turns.get(receipt.queuedTurnId ?? target.id)?.input).toBe("keep me");
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    });

  it.effect(
    "refuses unknown turns, non-senders, no sender, blank input and no live process before admission",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        const base = { turnId: turn.id, input: "words", sender: "user-1" };
        expect(
          (yield* host
            .steerTurn({ ...base, turnId: AgentTurnId.make("missing") })
            .pipe(Effect.flip))._tag,
        ).toBe("AgentTurnNotFoundError");
        expect((yield* host.steerTurn({ ...base, input: " \n\t" }).pipe(Effect.flip))._tag).toBe(
          "InvalidTurnSteerError",
        );
        expect(
          yield* host.steerTurn({ ...base, sender: "owner-1" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "TurnSteerForbiddenError", reason: "not-sender" });
        expect((yield* host.steerTurn(base).pipe(Effect.flip))._tag).toBe(
          "ProtocolHostNotLiveError",
        );
        world.turns.set(turn.id, new AgentTurn({ ...turn, author: null }));
        expect(yield* host.steerTurn(base).pipe(Effect.flip)).toMatchObject({
          _tag: "TurnSteerForbiddenError",
          reason: "no-sender",
        });
        expect((yield* world.steerStore.listConversationTurns(sessionId))[0]?.steers).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("keeps words as NotSent when a Stop detaches the process as they are queued", () => {
    const world = makeConversationWorld();
    const ended = world.seed("ended");
    world.turns.set(ended.id, new AgentTurn({ ...ended, status: "completed", endedAt: now() }));
    const peer = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.beforeSteerQueue = host.detach(processId);
      const receipt = yield* host.steerTurn({
        turnId: ended.id,
        sender: "user-1",
        input: "after the stop",
      });
      expect(yield* host.has(processId)).toBe(false);
      expect(receipt).toMatchObject({
        input: "after the stop",
        delivery: { _tag: "NotSent", reason: "turn-ended" },
        queuedTurnId: null,
      });
      expect(
        [...world.turns.values()].filter((turn) => turn.status === "queued").map((t) => t.input),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("leaves another Mend's Sending steer alone when the host starts", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const { steer } = Effect.runSync(
      world.steerStore.admitTurnSteer({
        turnId: turn.id,
        author: "user-1",
        input: "in flight elsewhere",
        clientSteerId: null,
      }),
    );
    return Effect.gen(function* () {
      yield* ProtocolHost;
      const steers = (yield* world.steerStore.listConversationTurns(sessionId)).flatMap(
        (row) => row.steers,
      );
      expect(steers.map((row) => [row.id, row.delivery])).toEqual([
        [steer.id, { _tag: "Sending" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("settles a delivery that dies as Unknown, never leaving it Sending", () => {
    const world = makeConversationWorld();
    const ended = world.seed("ended");
    world.turns.set(ended.id, new AgentTurn({ ...ended, status: "completed", endedAt: now() }));
    world.admission.beforeSteerQueue = Effect.die("database went away");
    const peer = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const attempt = yield* host
        .steerTurn({ turnId: ended.id, sender: "user-1", input: "lost in delivery" })
        .pipe(Effect.exit);
      expect(attempt._tag).toBe("Failure");
      const steers = (yield* world.steerStore.listConversationTurns(sessionId)).flatMap(
        (row) => row.steers,
      );
      expect(steers.map((row) => [row.input, row.delivery])).toEqual([
        ["lost in delivery", { _tag: "Unknown", reason: "failed" }],
      ]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("refuses a reused steer key that names another turn or other words", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const other = world.seed("other");
    world.turns.set(other.id, new AgentTurn({ ...other, status: "completed", endedAt: now() }));
    const peer = makePipe(["native"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const input = {
        turnId: turn.id,
        sender: "user-1",
        input: "first words",
        clientSteerId: crypto.randomUUID(),
      };
      const receipt = yield* host.steerTurn(input);
      for (const reuse of [
        { ...input, turnId: other.id },
        { ...input, input: "other words" },
        { ...input, clientSteerId: input.clientSteerId.toUpperCase(), input: "other words" },
      ]) {
        expect(yield* host.steerTurn(reuse).pipe(Effect.flip)).toMatchObject({
          _tag: "TurnSteerKeyConflictError",
          clientSteerId: input.clientSteerId,
        });
      }
      expect(
        yield* host.steerTurn({ ...input, clientSteerId: input.clientSteerId.toUpperCase() }),
      ).toEqual(receipt);
      expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("keeps an uncertain delivery and never queues or resends it", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makePipe(["native"], {
      steer: () => Promise.reject(new Error("pipe write failed")),
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const input = {
        turnId: turn.id,
        input: "keep uncertain words",
        sender: "user-1",
        clientSteerId: crypto.randomUUID(),
      };
      const receipt = yield* host.steerTurn(input);
      expect(receipt.delivery).toEqual({ _tag: "Unknown", reason: "uncertain" });
      expect(yield* host.steerTurn(input)).toEqual(receipt);
      expect(world.turns.size).toBe(1);
      expect((yield* world.steerStore.listConversationTurns(sessionId))[0]?.steers[0]?.input).toBe(
        input.input,
      );
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("keeps words as NotSent when definite non-delivery cannot be queued", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makePipe(["native"], {
      steer: (request, push) => {
        world.admission.stopping = true;
        push({ id: request.id, error: { code: -32600, message: "no active turn to steer" } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const receipt = yield* host.steerTurn({
        turnId: turn.id,
        input: "still readable",
        sender: "user-1",
      });
      expect(receipt).toMatchObject({
        input: "still readable",
        delivery: { _tag: "NotSent", reason: "no-active-turn" },
        queuedTurnId: null,
      });
      expect(world.turns.size).toBe(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("waits for the provider bind while dispatch holds its permit", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const starts: Array<PeerRequest> = [];
    const peer = makePipe([], {
      start: (request) => {
        starts.push(request);
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      const attaching = yield* attachCodex(host, peer.pipe).pipe(Effect.forkChild);
      yield* waitUntil(() => starts.length === 1);
      const steering = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "during dispatch" })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => world.turns.get(turn.id)?.status === "running");
      peer.push({ id: starts[0]?.id, result: { turn: { id: "native" } } });
      yield* Fiber.join(attaching);
      yield* TestClock.adjust("100 millis");
      expect((yield* Fiber.join(steering)).delivery._tag).toBe("Accepted");
      expect(
        peer.written.filter((frame) => frame.method === "turn/steer")[0]?.params?.expectedTurnId,
      ).toBe("native");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("queues after the bounded bind wait without waiting on the dispatch permit", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const starts: Array<PeerRequest> = [];
    const peer = makePipe([], {
      start: (request) => {
        starts.push(request);
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      const attaching = yield* attachCodex(host, peer.pipe).pipe(Effect.forkChild);
      yield* waitUntil(() => starts.length === 1);
      const steering = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "after bind timeout" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      const receipt = yield* Fiber.join(steering);
      expect(receipt.delivery).toEqual({
        _tag: "Queued",
        turnId: receipt.queuedTurnId,
        reason: "not-acknowledged",
      });
      expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(0);
      peer.push({ id: starts[0]?.id, result: { turn: { id: "native" } } });
      yield* Fiber.join(attaching);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect(
    "finishes delivery after the caller disconnects and completion wins before the RPC reply",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const next = world.seed("next");
      const requests: Array<PeerRequest> = [];
      const peer = makePipe(["native", "next-native"], {
        steer: (request) => {
          requests.push(request);
          return Promise.resolve();
        },
      });
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const input = {
          turnId: turn.id,
          sender: "user-1",
          input: "persist after disconnect",
          clientSteerId: crypto.randomUUID(),
        };
        const caller = yield* host.steerTurn(input).pipe(Effect.forkChild);
        yield* waitUntil(() => requests.length === 1);
        yield* host.interruptTurn(turn.id);
        expect(peer.interrupted).toEqual(["native"]);
        yield* Fiber.interrupt(caller);
        const sending = yield* host.steerTurn(input);
        expect(sending.delivery._tag).toBe("Sending");
        peer.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "native", status: "completed" } },
        });
        yield* waitUntil(() => world.turns.get(turn.id)?.status === "completed");
        expect(world.turns.get(next.id)?.status).toBe("queued");
        peer.push({ id: requests[0]?.id, result: { turnId: "native" } });
        yield* waitUntil(() => world.turns.get(next.id)?.providerTurnId === "next-native");
        const receipt = yield* host.steerTurn(input);
        expect(receipt.id).toBe(sending.id);
        expect(receipt.delivery).toEqual({ _tag: "Accepted", evidence: "provider-acknowledged" });
        expect(world.turns.get(turn.id)?.status).toBe("completed");
        expect(requests).toHaveLength(1);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("orders concurrent steer attempts and their saved ordinals", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const requests: Array<PeerRequest> = [];
    const peer = makePipe(["native"], {
      steer: (request) => {
        requests.push(request);
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const first = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "first" })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => requests.length === 1);
      const second = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "second" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("100 millis");
      expect(requests).toHaveLength(1);
      peer.push({ id: requests[0]?.id, result: { turnId: "native" } });
      yield* waitUntil(() => requests.length === 2);
      peer.push({ id: requests[1]?.id, result: { turnId: "native" } });
      const receipts = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(
        receipts.map((receipt) => [receipt.ordinal, receipt.input, receipt.delivery._tag]),
      ).toEqual([
        [0, "first", "Accepted"],
        [1, "second", "Accepted"],
      ]);
      expect(requests.map((request) => request.params?.input)).toEqual([
        [{ type: "text", text: "first" }],
        [{ type: "text", text: "second" }],
      ]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("delivers a delayed first admission before a second caller is admitted", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makePipe(["native"]);
    const steerFrames = () => peer.written.filter((request) => request.method === "turn/steer");
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const released = yield* Deferred.make<void>();
      let admissions = 0;
      world.admission.afterSteerAdmit = Effect.suspend(() =>
        admissions++ === 0 ? Deferred.await(released) : Effect.void,
      );
      const first = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "first" })
        .pipe(Effect.forkChild);
      yield* waitUntil(() => admissions === 1);
      const second = yield* host
        .steerTurn({ turnId: turn.id, sender: "user-1", input: "second" })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      expect(admissions).toBe(1);
      expect(steerFrames()).toEqual([]);
      yield* Deferred.succeed(released, undefined);
      const receipts = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(
        receipts.map((receipt) => [receipt.ordinal, receipt.input, receipt.delivery._tag]),
      ).toEqual([
        [0, "first", "Accepted"],
        [1, "second", "Accepted"],
      ]);
      expect(steerFrames().map((request) => request.params?.input)).toEqual([
        [{ type: "text", text: "first" }],
        [{ type: "text", text: "second" }],
      ]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("steers the turn's own process when a newer live process exists", () => {
    const world = makeConversationWorld();
    const target = world.seed("target");
    const other = new SessionProcess({ ...agentProcess, id: SessionProcessId.make("process-2") });
    const newerTurn = world.seed("newer");
    world.turns.set(newerTurn.id, new AgentTurn({ ...newerTurn, processId: other.id }));
    const original = makePipe(["original-native"]);
    const newer = makePipe(["newer-native"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, original.pipe);
      yield* host.attach({
        process: other,
        pipe: newer.pipe,
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        launchedWithLoginOf: "owner-1",
        hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
      });
      const receipt = yield* host.steerTurn({
        turnId: target.id,
        sender: "user-1",
        input: "only the original",
      });
      expect(receipt.delivery._tag).toBe("Accepted");
      expect(
        original.written
          .filter((frame) => frame.method === "turn/steer")
          .map((frame) => frame.params?.expectedTurnId),
      ).toEqual(["original-native"]);
      expect(newer.written.filter((frame) => frame.method === "turn/steer")).toEqual([]);
      expect(world.turns.get(newerTurn.id)?.providerTurnId).toBe("newer-native");
      yield* host.detach(processId);
      yield* host.detach(other.id);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer, [agentProcess, other])));
  });

  it.effect(
    "queues without a wire attempt when the adapter has no active steering capability",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makePipe(["native"]);
      const start = CodexAdapter.start;
      const adapter = vi.spyOn(CodexAdapter, "start").mockImplementation((transport, options) =>
        start(transport, options).pipe(
          Effect.map((session) => ({
            ...session,
            activeSteering: { supported: false, interruptsTools: false },
          })),
        ),
      );
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const receipt = yield* host.steerTurn({
          turnId: turn.id,
          sender: "user-1",
          input: "for an unsupported harness",
        });
        expect(receipt.delivery).toEqual({
          _tag: "Queued",
          turnId: receipt.queuedTurnId,
          reason: "unsupported",
        });
        expect(peer.written.filter((frame) => frame.method === "turn/steer")).toEqual([]);
        expect(
          [...world.turns.values()].find((row) => row.id === receipt.queuedTurnId)?.input,
        ).toBe("for an unsupported harness");
        yield* host.detach(processId);
      }).pipe(
        Effect.scoped,
        Effect.provide(hostLayer(world.layer)),
        Effect.ensuring(Effect.sync(() => adapter.mockRestore())),
      );
    },
  );

  it.effect("sweeps a replayed completion's requests again in a session that never steers", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makePipe(["native"]);
    const completions: Array<AgentTurn> = [];
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* host.attach({
        process: agentProcess,
        pipe: peer.pipe,
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        launchedWithLoginOf: "owner-1",
        hooks: {
          onRequestChanged: () => Effect.void,
          onTurnCompleted: (ended) =>
            Effect.sync(() => {
              completions.push(ended);
            }),
        },
      });
      const completed = (status: string) => ({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "native", status } },
      });
      peer.push(completed("interrupted"));
      yield* waitUntil(() => completions.length === 1);
      peer.push(completed("completed"));
      yield* waitUntil(() => completions.length === 2);
      expect(completions.map((ended) => ended.status)).toEqual(["interrupted", "completed"]);
      expect(world.cancelSweeps).toEqual([turn.id, turn.id]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  const claudeProcess = new SessionProcess({ ...agentProcess, harness: "claude", label: "claude" });
  const attachClaude = (
    host: ProtocolHost["Service"],
    peer: ReturnType<typeof makeClaudePipe>,
    onTurnCompleted: (turn: AgentTurn) => Effect.Effect<void> = () => Effect.void,
  ) =>
    host.attach({
      process: claudeProcess,
      pipe: peer.pipe,
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: "owner-1",
      hooks: { onRequestChanged: () => Effect.void, onTurnCompleted },
    });
  const aborted = {
    type: "result",
    subtype: "error_during_execution",
    uuid: "abort",
    terminal_reason: "aborted_tools",
    errors: ["tools aborted"],
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  const continued = { type: "system", subtype: "init", uuid: "continued" };
  const finished = {
    type: "result",
    subtype: "success",
    uuid: "finished",
    usage: { input_tokens: 20, output_tokens: 3 },
  };
  const marker = {
    type: "system",
    subtype: "task_started",
    task_id: "marker",
    task_type: "local_workflow",
    description: "marker task",
  };

  it.effect(
    "journals Claude steering, folds its continuation and queues a second steer in the gap",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makeClaudePipe();
      const completed: Array<AgentTurn> = [];
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachClaude(host, peer, (ended) => Effect.sync(() => void completed.push(ended)));
        const receipt = yield* host.steerTurn({
          turnId: turn.id,
          sender: "user-1",
          input: "Keep the shape",
        });
        expect(receipt.delivery).toEqual({ _tag: "Accepted", evidence: "transport-written" });
        const journal = yield* world.steerStore.protocolControls(processId);
        expect(journal).toEqual([
          {
            ordinal: 0,
            controlId: receipt.id,
            providerTurnId: world.turns.get(turn.id)?.providerTurnId,
            afterOutputLine: 0,
            action: "steer-now",
          },
        ]);
        expect(peer.sent.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({ type: "user", priority: "now", uuid: receipt.id }),
        );
        peer.push(aborted);
        peer.push(marker);
        yield* waitUntil(() => world.items.has("task:marker"));
        expect(world.turns.get(turn.id)?.status).toBe("running");
        expect(completed).toEqual([]);
        const gap = yield* host.steerTurn({ turnId: turn.id, sender: "user-1", input: "one more" });
        expect(gap.delivery).toEqual({
          _tag: "Queued",
          turnId: gap.queuedTurnId,
          reason: "in-continuation",
        });
        peer.push(continued);
        peer.push(finished);
        yield* waitUntil(() => completed.length === 1);
        expect(completed[0]).toMatchObject({
          id: turn.id,
          status: "completed",
          error: null,
          usage: { inputTokens: 30, outputTokens: 5 },
        });
        expect([...world.turns.values()].filter((row) => row.origin === "harness")).toEqual([]);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect(
    "a failed Claude journal queues the unsent steer and fails Stop without writing it",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makeClaudePipe();
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachClaude(host, peer);
        world.admission.journalFailure = true;
        const receipt = yield* host.steerTurn({
          turnId: turn.id,
          sender: "user-1",
          input: "keep unsent words",
        });
        expect(receipt.delivery).toEqual({
          _tag: "Queued",
          turnId: receipt.queuedTurnId,
          reason: "not-written",
        });
        expect((yield* host.interruptTurn(turn.id).pipe(Effect.result))._tag).toBe("Failure");
        expect(peer.sent).toHaveLength(1);
        expect(world.turns.get(turn.id)?.status).toBe("running");
        expect(
          (yield* world.steerStore.listConversationTurns(sessionId))[0]?.steers[0]?.input,
        ).toBe("keep unsent words");
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("dispatches again when Claude reports idle after Stop drains a steer", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const next = world.seed("next");
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      yield* host.steerTurn({ turnId: turn.id, sender: "user-1", input: "now" });
      peer.push(aborted);
      peer.push(marker);
      yield* waitUntil(() => world.items.has("task:marker"));
      yield* host.interruptTurn(turn.id);
      yield* Deferred.await(world.requeued);
      expect(world.turns.get(turn.id)?.status).toBe("interrupted");
      expect(world.turns.get(next.id)).toMatchObject({ status: "queued", providerTurnId: null });
      expect(peer.sent.filter((line) => line.includes('"type":"user"'))).toHaveLength(2);
      peer.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      yield* waitUntil(() => world.turns.get(next.id)?.providerTurnId !== null);
      expect(world.turns.get(next.id)?.status).toBe("running");
      expect(peer.sent.filter((line) => line.includes('"type":"user"'))).toHaveLength(3);
      expect(
        (yield* world.steerStore.protocolControls(processId)).map((row) => row.action),
      ).toEqual(["steer-now", "interrupt"]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("dispatches again when Claude's idle after a drained Stop ends mid-chunk", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const next = world.seed("next");
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      yield* host.steerTurn({ turnId: turn.id, sender: "user-1", input: "now" });
      peer.push(aborted);
      peer.push(marker);
      yield* waitUntil(() => world.items.has("task:marker"));
      yield* host.interruptTurn(turn.id);
      yield* Deferred.await(world.requeued);
      const idle = { type: "system", subtype: "session_state_changed", state: "idle" };
      peer.pushRaw(`${JSON.stringify(idle)}\n{"type":"sys`);
      yield* waitUntil(() => world.turns.get(next.id)?.providerTurnId !== null);
      expect(world.turns.get(next.id)?.status).toBe("running");
      expect(peer.sent.filter((line) => line.includes('"type":"user"'))).toHaveLength(3);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live(
    "rehydrates Claude's journal without writing stdin, and preserves Sending as Unknown",
    () => {
      const world = makeConversationWorld();
      const turn = world.seed("start");
      const peer = makeClaudePipe();
      const completed: Array<AgentTurn> = [];
      const beforeRestart = Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachClaude(host, peer);
        yield* host.steerTurn({
          turnId: turn.id,
          sender: "user-1",
          input: "accepted before restart",
        });
        peer.push(aborted);
        peer.push(marker);
        yield* waitUntil(() => world.items.has("task:marker"));
        yield* world.steerStore.admitTurnSteer({
          turnId: turn.id,
          author: "user-1",
          input: "saved before crash",
          clientSteerId: null,
        });
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
      return Effect.gen(function* () {
        yield* beforeRestart;
        const replay = makeClaudePipe();
        replay.push(aborted);
        replay.push(marker);
        replay.push(continued);
        replay.push(finished);
        yield* Effect.gen(function* () {
          const host = yield* ProtocolHost;
          yield* host.rehydrate({
            process: new SessionProcess({ ...claudeProcess, providerSessionId: "claude-session" }),
            pipe: replay.pipe,
            cwd: "/workspace/repo",
            permissionMode: "bypass",
            launchedWithLoginOf: "owner-1",
            highWater: 3n,
            hooks: {
              onRequestChanged: () => Effect.void,
              onTurnCompleted: (row) => Effect.sync(() => void completed.push(row)),
            },
          });
          yield* waitUntil(() => world.turns.get(turn.id)?.status === "completed");
          expect(completed).toHaveLength(1);
          expect(completed[0]).toMatchObject({
            id: turn.id,
            status: "completed",
            usage: { inputTokens: 30, outputTokens: 5 },
          });
          expect(replay.sent).toEqual([]);
          const turns = yield* world.steerStore.listConversationTurns(sessionId);
          expect(turns).toHaveLength(1);
          expect(turns[0]?.steers.map((row) => [row.input, row.delivery._tag])).toEqual([
            ["accepted before restart", "Accepted"],
            ["saved before crash", "Unknown"],
          ]);
          expect(turns[0]?.steers[1]?.delivery).toEqual({ _tag: "Unknown", reason: "restart" });
          expect(yield* world.steerStore.protocolControls(processId)).toHaveLength(1);
          yield* host.detach(processId);
        }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
      });
    },
  );
});
