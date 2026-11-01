import { CodexAdapter } from "@mend/agent-protocol";
import {
  AgentConversationRepo,
  AgentControlJournalError,
  AgentTurnNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SessionStoppingError,
} from "@mend/db";
import { ClientMessageId } from "@mend/domain";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import {
  MessageInput,
  TURN_DELIVERY_UNCONFIRMED,
  type AgentTurnSteer,
} from "@mend/domain/workbench";
import { AgentItem, AgentRequest, AgentTurn, SessionProcess } from "@mend/domain/workbench";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { InteractiveSession } from "@sealant/sdk";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, References } from "effect";
import { describe, expect, vi } from "vitest";

import {
  ProtocolHost,
  ProtocolHostLive,
  type MessageSendError,
  type TurnSteerError,
} from "../src/protocol-host.ts";
import type { SteerTurnInput } from "../src/protocol-steer.ts";
import { makePipe, type PeerRequest } from "./support/codex-peer.ts";
import { makeDispatchStore } from "./support/dispatch-store.ts";
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
    beforeUpsert: Effect.Effect<void>;
    beforeRequest: Effect.Effect<void>;
    afterSteerAdmit: Effect.Effect<void>;
    afterMessageAdmit: Effect.Effect<void>;
    beforeSteerQueue: Effect.Effect<void>;
    afterSteerQueue: Effect.Effect<void>;
    beforeClaim: Effect.Effect<void>;
    afterClaim: Effect.Effect<void>;
    beforeBind: Effect.Effect<void>;
    beforePayer: Effect.Effect<void>;
    beforeRequeue: Effect.Effect<void>;
    beforeFail: Effect.Effect<void>;
    afterUnconfirmed: Effect.Effect<void>;
    beforeCancel: Effect.Effect<void>;
    beforeWithdraw: Effect.Effect<void>;
  } = {
    stopping: false,
    journalFailure: false,
    beforeAdmit: Effect.void,
    beforeHarnessTurn: Effect.void,
    beforeComplete: Effect.void,
    beforeUpsert: Effect.void,
    beforeRequest: Effect.void,
    afterSteerAdmit: Effect.void,
    afterMessageAdmit: Effect.void,
    beforeSteerQueue: Effect.void,
    afterSteerQueue: Effect.void,
    beforeClaim: Effect.void,
    afterClaim: Effect.void,
    beforeBind: Effect.void,
    beforePayer: Effect.void,
    beforeRequeue: Effect.void,
    beforeFail: Effect.void,
    afterUnconfirmed: Effect.void,
    beforeCancel: Effect.void,
    beforeWithdraw: Effect.void,
  };
  const requeued = Effect.runSync(Deferred.make<void>());
  const items = new Map<string, AgentItem>();
  const itemWrites: Array<Parameters<AgentConversationRepo["Service"]["upsertItem"]>[0]> = [];
  const cancelSweeps: Array<AgentTurnId> = [];
  const steerStore = makeSteerStore(turns, () => admission.stopping);
  const dispatch = makeDispatchStore(turns, () => ordinal++);
  const layer = Layer.succeed(AgentConversationRepo, {
    ...steerStore,
    withdrawMessageTurn: (id, onProcess) =>
      Effect.suspend(() => admission.beforeWithdraw).pipe(
        Effect.andThen(steerStore.withdrawMessageTurn(id, onProcess)),
      ),
    admitSteerMessage: (input, turnId) =>
      admission.beforeAdmit.pipe(
        Effect.andThen(steerStore.admitSteerMessage(input, turnId)),
        Effect.tap(() => admission.afterMessageAdmit),
        Effect.tap((admitted) =>
          admitted._tag === "Created" ? admission.afterSteerAdmit : Effect.void,
        ),
      ),
    admitTurnMessage: (input, onProcess, reason) =>
      admission.beforeAdmit.pipe(
        Effect.andThen(steerStore.admitTurnMessage(input, onProcess, reason)),
        Effect.tap(() => admission.afterMessageAdmit),
      ),
    admitTurnSteer: (input) =>
      steerStore.admitTurnSteer(input).pipe(Effect.tap(() => admission.afterSteerAdmit)),
    queueTurnSteer: (id, onProcess, reason) =>
      Effect.suspend(() => admission.beforeSteerQueue).pipe(
        Effect.andThen(steerStore.queueTurnSteer(id, onProcess, reason)),
        Effect.tap(() => Effect.suspend(() => admission.afterSteerQueue)),
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
        Effect.tap(() => admission.afterMessageAdmit),
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
    claimNextTurn: (onProcess, attempt) =>
      Effect.suspend(() => admission.beforeClaim).pipe(
        Effect.andThen(dispatch.claimNextTurn(onProcess, attempt)),
        Effect.tap(() => Effect.suspend(() => admission.afterClaim)),
      ),
    openHarnessTurn: (session, onProcess, providerTurnId, reason, payer, ended) =>
      admission.beforeHarnessTurn.pipe(
        Effect.andThen(
          dispatch.openHarnessTurn(session, onProcess, providerTurnId, reason, payer, ended),
        ),
      ),
    unsentClaim: dispatch.unsentClaim,
    putBackOwn: (claim, release) =>
      Effect.suspend(() => admission.beforeRequeue).pipe(
        Effect.andThen(dispatch.putBackOwn(claim, release)),
        Effect.tap(() => Deferred.succeed(requeued, undefined)),
      ),
    bindOwnSend: (claim, providerTurnId, payer, replacing) =>
      Effect.suspend(() => admission.beforeBind).pipe(
        Effect.andThen(Effect.suspend(() => admission.beforePayer)),
        Effect.andThen(dispatch.bindOwnSend(claim, providerTurnId, payer, replacing)),
      ),
    failOwn: (claim, error, release) =>
      Effect.suspend(() => admission.beforeFail).pipe(
        Effect.andThen(dispatch.failOwn(claim, error, release)),
        Effect.tap(() =>
          error === TURN_DELIVERY_UNCONFIRMED
            ? Effect.suspend(() => admission.afterUnconfirmed)
            : Effect.void,
        ),
      ),
    setTurnPayer: (id, payer) =>
      Effect.suspend(() => admission.beforePayer).pipe(
        Effect.map(() =>
          update(id, {
            billedUserId: payer.userId,
            billedAccountId: payer.accountId,
            billedAccountName: payer.accountName,
          }),
        ),
      ),
    failTurn: (id, error) =>
      Effect.suspend(() => admission.beforeFail).pipe(
        Effect.flatMap(() =>
          ["queued", "running", "failed"].includes(turns.get(id)?.status ?? "")
            ? Effect.succeed(update(id, { status: "failed", error, endedAt: now() }))
            : Effect.fail(new AgentTurnNotFoundError({ turnId: id })),
        ),
      ),
    failUnconfirmedTurn: (id) =>
      Effect.suspend(() => admission.beforeFail).pipe(
        Effect.map(() => {
          const turn = turns.get(id);
          return turn?.status === "running" && turn.providerTurnId === null
            ? update(id, { status: "failed", error: TURN_DELIVERY_UNCONFIRMED, endedAt: now() })
            : null;
        }),
        Effect.tap(() => Effect.suspend(() => admission.afterUnconfirmed)),
      ),
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
      Effect.andThen(
        admission.beforeUpsert,
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
          itemWrites.push(input);
          return item;
        }),
      ),
    listItems: () => Effect.succeed([]),
    turnMessages: () => Effect.succeed([]),
    turnItems: () => Effect.succeed([]),
    openRequest: (input) =>
      admission.beforeRequest.pipe(
        Effect.as(
          new AgentRequest({
            ...input,
            id: AgentRequestId.make(input.providerRequestId),
            status: "pending",
            decision: null,
            decidedBy: null,
            answers: null,
            createdAt: now(),
            decidedAt: null,
          }),
        ),
      ),
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
      Effect.suspend(() => admission.beforeCancel).pipe(
        Effect.andThen(
          Effect.sync(() => {
            cancelSweeps.push(turnId);
            const turn = turns.get(turnId);
            if (turn !== undefined && turn.status === "queued") {
              update(turnId, { status: "cancelled", endedAt: now() });
            }
          }),
        ),
      ),
    cancelOpenForProcess: () => Effect.void,
    protocolCursor: () => Effect.succeed({ nextSequence: 0n }),
    backfillConversation: () => Effect.succeed(0),
    resetSendingResponses: () => Effect.void,
    requeueQueuedTurns: (from, to) =>
      Effect.sync(() => {
        for (const turn of turns.values())
          if (turn.processId === from && turn.status === "queued")
            update(turn.id, { processId: to });
      }),
    saveProtocolCursor: () => Effect.void,
  });
  return { layer, turns, items, itemWrites, seed, admission, steerStore, requeued, cancelSweeps };
};

const processesLayer = (rows: ReadonlyArray<SessionProcess> = [agentProcess]) =>
  Layer.succeed(SessionProcessesRepo, {
    create: () => Effect.die("not in test"),
    byId: (id) => Effect.succeed(rows.find((row) => row.id === id) ?? null),
    launchOf: () => Effect.succeed(null),
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

/** A Claude Code on the far side of a pipe: records what Mend sends, says what the test pushes. */
const makeClaudePipe = () => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const sent: Array<string> = [];
  let refuseNextTurn = false;
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
      const text = typeof input === "string" ? input : new TextDecoder().decode(input);
      if (refuseNextTurn && text.includes('"type":"user"')) {
        refuseNextTurn = false;
        return Promise.reject(new Error("pipe write failed"));
      }
      sent.push(text);
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
  return {
    pipe,
    push,
    pushRaw,
    pendingOutput: () => pending.length,
    sent,
    refuseNextTurn: () => {
      refuseNextTurn = true;
    },
  };
};

const hostLayer = (
  conversation: Layer.Layer<AgentConversationRepo>,
  rows?: ReadonlyArray<SessionProcess>,
) =>
  ProtocolHostLive.pipe(
    Layer.provideMerge(conversation),
    Layer.provide(processesLayer(rows)),
    Layer.provide(sessionsLayer),
  );

const nativeCompleted = (status: string) => ({
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id: "native", status } },
});

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
    expect.fail("condition never became true");
  });

const turnWith = (world: ReturnType<typeof makeConversationWorld>, words: string) =>
  [...world.turns.values()].find((turn) => turn.input === words);
const turnStarts = (peer: ReturnType<typeof makePipe>) =>
  peer.written.filter((frame) => frame.method === "turn/start").length;
const startsWith = (peer: ReturnType<typeof makePipe>, words: string) =>
  peer.written.filter(
    (frame) => frame.method === "turn/start" && frame.params?.input?.[0]?.text === words,
  ).length;
const userFrames = (peer: ReturnType<typeof makeClaudePipe>) =>
  peer.sent.filter((line) => line.includes('"type":"user"'));
/** `effect` the first time it runs, nothing after: one failed database call. */
const once = (effect: Effect.Effect<void>): Effect.Effect<void> => {
  let ran = false;
  return Effect.suspend(() => {
    if (ran) return Effect.void;
    ran = true;
    return effect;
  });
};

const attachCodex = (host: ProtocolHost["Service"], pipe: InteractiveSession) =>
  host.attach({
    process: agentProcess,
    pipe,
    cwd: "/workspace/repo",
    permissionMode: "bypass",
    launchedWithLoginOf: "owner-1",
    hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
  });

const autonomousStarted = {
  method: "turn/started",
  params: { threadId: "thread-1", turn: { id: "autonomous" } },
};
const autonomousCompleted = {
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id: "autonomous", status: "completed" } },
};
const autonomousEnded = (world: ReturnType<typeof makeConversationWorld>) => () =>
  [...world.turns.values()].some(
    (turn) => turn.providerTurnId === "autonomous" && turn.status === "completed",
  );

describe.each(["turn", "message"] as const)("ProtocolHost through %s", (via) => {
  /** Through a message, a retry reads its key first, as the engine does. */
  const sendSteer = (
    host: ProtocolHost["Service"],
    input: SteerTurnInput,
  ): Effect.Effect<AgentTurnSteer, MessageSendError | TurnSteerError, AgentConversationRepo> =>
    via === "turn"
      ? host.steerTurn(input)
      : Effect.gen(function* () {
          const message = {
            sessionId,
            sender: input.sender,
            input: MessageInput.make(input.input),
            clientMessageId:
              input.clientSteerId == null
                ? null
                : ClientMessageId.make(input.clientSteerId.toLowerCase()),
            intent: "default" as const,
          };
          const result =
            (yield* (yield* AgentConversationRepo).messageByClientId(message)) ??
            (yield* host.sendMessage(message, { _tag: "Steer", turnId: input.turnId }));
          if (result._tag !== "Steer") return yield* Effect.die("expected steer");
          return result.steer;
        });
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

  /** A new turn with these words, through a turn or a message: a message's explanation. */
  const submit = (host: ProtocolHost["Service"], words: string) =>
    via === "turn"
      ? host.submitTurn(sessionId, words, "user-1").pipe(Effect.as(null))
      : host
          .sendMessage(
            {
              sessionId,
              sender: "user-1",
              input: MessageInput.make(words),
              clientMessageId: null,
              intent: "queue",
            },
            { _tag: "Turn", reason: "queue-requested" },
          )
          .pipe(Effect.map((receipt) => receipt.explanation));

  it.live("sends a message once when Codex runs a turn of its own between claim and answer", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["turn-a", "turn-b", "turn-c"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterClaim = once(
        Effect.sync(() => {
          peer.push(autonomousStarted);
          peer.push(autonomousCompleted);
        }).pipe(Effect.andThen(waitUntil(autonomousEnded(world)))),
      );
      yield* submit(host, "healthy storage words");
      yield* Effect.sleep("100 millis");
      expect(startsWith(peer, "healthy storage words")).toBe(1);
      expect(turnWith(world, "healthy storage words")).toMatchObject({
        status: "running",
        providerTurnId: "turn-a",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("never puts back a claim when Codex's own turn is recorded after the claim", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["human-a", "human-b"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const eventEntered = yield* Deferred.make<void>();
      const releaseEvent = yield* Deferred.make<void>();
      world.admission.beforeHarnessTurn = Deferred.succeed(eventEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseEvent)),
      );
      world.admission.afterMessageAdmit = once(
        Effect.sync(() => peer.push(autonomousStarted)).pipe(
          Effect.andThen(Deferred.await(eventEntered)),
        ),
      );
      world.admission.afterClaim = once(
        Deferred.succeed(releaseEvent, undefined).pipe(
          Effect.andThen(Effect.sync(() => peer.push(autonomousCompleted))),
          Effect.andThen(waitUntil(autonomousEnded(world))),
        ),
      );
      yield* submit(host, "healthy words");
      yield* Effect.sleep("100 millis");
      expect(startsWith(peer, "healthy words")).toBe(1);
      expect(turnWith(world, "healthy words")).toMatchObject({
        status: "running",
        providerTurnId: "human-a",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("fails a message Codex rejected after its own turn ended during the send", () => {
    const world = makeConversationWorld();
    let attempts = 0;
    const peer = makePipe([], {
      start: (request, push) => {
        attempts += 1;
        if (attempts === 1) {
          push(autonomousCompleted);
          push({ id: request.id, error: { message: "model unavailable" } });
        } else push({ id: request.id, result: { turn: { id: "human-a" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const eventEntered = yield* Deferred.make<void>();
      world.admission.beforeHarnessTurn = Deferred.succeed(eventEntered, undefined).pipe(
        Effect.asVoid,
      );
      world.admission.afterClaim = once(
        Effect.sync(() => peer.push(autonomousStarted)).pipe(
          Effect.andThen(Deferred.await(eventEntered)),
          Effect.andThen(Effect.sleep("20 millis")),
        ),
      );
      yield* submit(host, "healthy words");
      yield* Effect.sleep("100 millis");
      expect(attempts).toBe(1);
      expect(turnWith(world, "healthy words")).toMatchObject({
        status: "failed",
        providerTurnId: null,
        error: expect.stringContaining("model unavailable"),
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("never completes a rejected message with another turn's end seen during the send", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        push(autonomousCompleted);
        push({ id: request.id, error: { message: "model unavailable" } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      yield* submit(host, "healthy words");
      yield* Effect.sleep("50 millis");
      expect(turnWith(world, "healthy words")).toMatchObject({
        status: "failed",
        providerTurnId: null,
        error: expect.stringContaining("model unavailable"),
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("fails a message Codex rejected while a turn of its own started during the send", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        push(autonomousStarted);
        push({ id: request.id, error: { message: "model unavailable" } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      yield* submit(host, "healthy words");
      peer.push(autonomousCompleted);
      yield* Effect.sleep("100 millis");
      expect(startsWith(peer, "healthy words")).toBe(1);
      expect(turnWith(world, "healthy words")).toMatchObject({
        status: "failed",
        providerTurnId: null,
        error: expect.stringContaining("model unavailable"),
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("binds a turn to the id Codex answered, not one that started during the send", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        push(autonomousStarted);
        push({ id: request.id, result: { turn: { id: "human-a" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      yield* submit(host, "healthy words");
      yield* waitUntil(() => turnWith(world, "healthy words")?.providerTurnId === "human-a");
      peer.push(autonomousCompleted);
      yield* Effect.sleep("50 millis");
      expect(turnWith(world, "healthy words")).toMatchObject({ status: "running" });
      peer.push({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "human-a", status: "completed" } },
      });
      yield* waitUntil(() => turnWith(world, "healthy words")?.status === "completed");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("completes a fast turn whose end arrives before Codex's answer to the send", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-a", status: "completed" } },
        });
        push({ id: request.id, result: { turn: { id: "turn-a" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      yield* submit(host, "quick words");
      yield* waitUntil(() => turnWith(world, "quick words")?.status === "completed");
      expect(turnWith(world, "quick words")).toMatchObject({
        providerTurnId: "turn-a",
        error: null,
      });
      expect(startsWith(peer, "quick words")).toBe(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live(
    "puts a claim no dispatch holds back when Codex opens its own turn on an idle host",
    () => {
      const world = makeConversationWorld();
      const peer = makePipe([]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        const orphan = world.seed("orphaned");
        world.turns.set(
          orphan.id,
          new AgentTurn({ ...orphan, status: "running", providerTurnId: null, startedAt: now() }),
        );
        peer.push(autonomousStarted);
        yield* waitUntil(() =>
          [...world.turns.values()].some(
            (turn) => turn.providerTurnId === "autonomous" && turn.status === "running",
          ),
        );
        expect(turnWith(world, "orphaned")).toMatchObject({ status: "queued", startedAt: null });
        expect(turnStarts(peer)).toBe(0);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.live("interrupts and never resends a turn a Stop ended while Codex had not answered", () => {
    const world = makeConversationWorld();
    const answers: Array<() => void> = [];
    const peer = makePipe([], {
      start: (request, push) => {
        answers.push(() => push({ id: request.id, result: { turn: { id: "turn-a" } } }));
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const caller = yield* submit(host, "stopped words").pipe(Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      const sending = turnWith(world, "stopped words");
      if (sending === undefined) return expect.fail("the turn was not admitted");
      world.turns.set(
        sending.id,
        new AgentTurn({ ...sending, status: "cancelled", endedAt: now() }),
      );
      for (const answer of answers) answer();
      yield* Fiber.join(caller);
      yield* waitUntil(() => peer.interrupted.length === 1);
      expect(peer.interrupted).toEqual(["turn-a"]);
      expect(turnWith(world, "stopped words")).toMatchObject({
        status: "cancelled",
        providerTurnId: null,
      });
      yield* Effect.sleep("50 millis");
      expect(startsWith(peer, "stopped words")).toBe(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("withdraws a turn whose claim failed before writing it, and sends the next", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["turn-a", "turn-b"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterClaim = once(Effect.die("the claim's notification failed"));
      const first = yield* submit(host, "first").pipe(Effect.exit);
      expect(turnStarts(peer)).toBe(0);
      expect(turnWith(world, "first")).toMatchObject({ status: "cancelled", providerTurnId: null });
      if (via === "turn") expect(Exit.isFailure(first) && Cause.hasDies(first.cause)).toBe(true);
      else
        expect(first).toEqual(Exit.succeed("not sent · the turn was cancelled before it started"));
      yield* submit(host, "second");
      expect(turnWith(world, "second")).toMatchObject({
        status: "running",
        providerTurnId: "turn-a",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("puts back a lost claim once storage answers again, and sends what follows", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["turn-a", "turn-b"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterClaim = once(Effect.die("lost commit acknowledgement"));
      world.admission.beforeRequeue = once(Effect.die("storage still down during recovery"));
      const first = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
      for (let attempt = 0; attempt < 200 && first.pollUnsafe() === undefined; attempt += 1) {
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      }
      yield* Fiber.join(first);
      // The caller heard its turn was not sent, so the turn put back is withdrawn, never sent later.
      expect(turnWith(world, "first")).toMatchObject({ status: "cancelled", providerTurnId: null });
      yield* submit(host, "second");
      expect(startsWith(peer, "first")).toBe(0);
      expect(turnWith(world, "second")).toMatchObject({
        status: "running",
        providerTurnId: "turn-a",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("answers with the turn another dispatch sent, so a resend never sends it twice", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["turn-a", "turn-b", "turn-c"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const slowWithdrawal = once(
        Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
      );
      world.admission.beforeCancel = slowWithdrawal;
      world.admission.beforeWithdraw = slowWithdrawal;
      const release = yield* Deferred.make<void>();
      world.admission.afterClaim = once(
        Deferred.await(release).pipe(Effect.andThen(Effect.die("lost claim acknowledgement"))),
      );
      const first = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "first")?.status === "running");
      const second = yield* submit(host, "second").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "second") !== undefined);
      yield* Deferred.succeed(release, undefined);
      const answered = yield* Fiber.join(first);
      yield* Fiber.join(second);
      // The waiting dispatch sent the turn put back: the caller hears so, and has no reason to
      // send these words again.
      expect(startsWith(peer, "first")).toBe(1);
      expect(Exit.isSuccess(answered)).toBe(true);
      if (via === "message")
        expect(answered).toEqual(
          Exit.succeed(
            "sent as your next turn · you asked for a new turn · turn running · observed",
          ),
        );
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("answers with the turn another dispatch sent when its withdrawal also failed", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["turn-a", "turn-b", "turn-c"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const failingWithdrawal = once(
        Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50))).pipe(
          Effect.andThen(Effect.die("withdrawal query connection dropped")),
        ),
      );
      world.admission.beforeCancel = failingWithdrawal;
      world.admission.beforeWithdraw = failingWithdrawal;
      const release = yield* Deferred.make<void>();
      world.admission.afterClaim = once(
        Deferred.await(release).pipe(Effect.andThen(Effect.die("lost claim acknowledgement"))),
      );
      const first = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "first")?.status === "running");
      const second = yield* submit(host, "second").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "second") !== undefined);
      yield* Deferred.succeed(release, undefined);
      for (let attempt = 0; attempt < 200 && first.pollUnsafe() === undefined; attempt += 1) {
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      }
      const answered = yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(startsWith(peer, "first")).toBe(1);
      expect(Exit.isSuccess(answered)).toBe(true);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("sends the next turn when settling an unconfirmed one lost its answer", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        if (turnStarts(peer) > 1) push({ id: request.id, result: { turn: { id: "turn-b" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const first = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      world.seed("second");
      world.admission.afterUnconfirmed = once(Effect.die("lost settlement acknowledgement"));
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(first);
      for (
        let attempt = 0;
        attempt < 50 && turnWith(world, "second")?.status !== "running";
        attempt += 1
      ) {
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      }
      expect(turnWith(world, "first")).toMatchObject({
        status: "failed",
        error: TURN_DELIVERY_UNCONFIRMED,
      });
      expect(startsWith(peer, "first")).toBe(1);
      expect(turnWith(world, "second")).toMatchObject({
        status: "running",
        providerTurnId: "turn-b",
      });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("sends a turn on the successor when its process handed over before dispatch", () => {
    const world = makeConversationWorld();
    const successor = new SessionProcess({
      ...agentProcess,
      id: SessionProcessId.make("process-2"),
    });
    const peer = makePipe([]);
    const next = makePipe(["on-successor"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.beforeAdmit = Effect.suspend(() => {
        world.admission.beforeAdmit = Effect.void;
        return Effect.gen(function* () {
          yield* host
            .attach({
              process: successor,
              pipe: next.pipe,
              cwd: "/workspace/repo",
              permissionMode: "bypass",
              launchedWithLoginOf: "owner-1",
              hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
            })
            .pipe(Effect.orDie);
          yield* host.detach(processId);
        });
      });
      yield* submit(host, "handed over");
      expect(turnWith(world, "handed over")).toMatchObject({
        processId: successor.id,
        status: "running",
        providerTurnId: "on-successor",
      });
      expect(turnStarts(peer)).toBe(0);
      yield* host.detach(successor.id);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer, [agentProcess, successor])));
  });

  it.effect("leaves a turn to the successor that took it when its dispatch failed", () => {
    const world = makeConversationWorld();
    const successor = new SessionProcess({
      ...agentProcess,
      id: SessionProcessId.make("process-2"),
    });
    const busy = world.seed("the successor's own turn");
    world.turns.set(
      busy.id,
      new AgentTurn({
        ...busy,
        processId: successor.id,
        status: "running",
        providerTurnId: "busy",
        startedAt: now(),
      }),
    );
    const peer = makePipe([]);
    const next = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      // The process the turn was placed on hands over before the turn is stored, and the
      // successor's own claim fails after it took the turn.
      world.admission.beforeAdmit = Effect.suspend(() => {
        world.admission.beforeAdmit = Effect.void;
        return Effect.gen(function* () {
          yield* host
            .attach({
              process: successor,
              pipe: next.pipe,
              cwd: "/workspace/repo",
              permissionMode: "bypass",
              launchedWithLoginOf: "owner-1",
              hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
            })
            .pipe(Effect.orDie);
          yield* host.detach(processId);
          world.admission.beforeClaim = once(Effect.die("the successor's claim failed"));
        });
      });
      yield* submit(host, "handed over").pipe(Effect.exit);
      expect(turnWith(world, "handed over")).toMatchObject({
        processId: successor.id,
        status: "queued",
      });
      yield* host.detach(successor.id);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer, [agentProcess, successor])));
  });

  it.effect("puts back only the turn a failed claim took", () => {
    const world = makeConversationWorld();
    const earlier = world.seed("earlier");
    world.turns.set(
      earlier.id,
      new AgentTurn({ ...earlier, status: "running", startedAt: new Date(0) }),
    );
    const peer = makePipe(["turn-a"]);
    return Effect.gen(function* () {
      yield* TestClock.adjust("1 second");
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterClaim = once(Effect.die("the claim's notification failed"));
      yield* submit(host, "first").pipe(Effect.exit);
      expect(turnWith(world, "earlier")).toMatchObject({ status: "running", providerTurnId: null });
      expect(turnStarts(peer)).toBe(0);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect(
    "never sends a written turn again when recording it failed and a later claim failed",
    () => {
      const world = makeConversationWorld();
      const peer = makePipe(["turn-a", "turn-b"]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        world.admission.beforePayer = once(Effect.die("the payer's save failed"));
        const first = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
        for (let attempt = 0; attempt < 200 && first.pollUnsafe() === undefined; attempt += 1) {
          yield* TestClock.adjust("1 second");
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
        }
        yield* Fiber.join(first);
        world.admission.afterClaim = once(Effect.die("the claim's notification failed"));
        yield* submit(host, "second").pipe(Effect.exit);
        yield* submit(host, "third").pipe(Effect.exit);
        expect(startsWith(peer, "first")).toBe(1);
        expect(turnWith(world, "first")).toMatchObject({
          status: "running",
          providerTurnId: "turn-a",
          billedUserId: "owner-1",
        });
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("keeps a turn Codex said it started while its answer was lost, and its replies", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], { start: () => Promise.resolve() });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      // Codex says the turn started; its bind is still on its way when the send's answer is lost.
      const bind = yield* Deferred.make<void>();
      let binding = false;
      world.admission.beforeBind = once(
        Effect.sync(() => {
          binding = true;
        }).pipe(Effect.andThen(Deferred.await(bind))),
      );
      world.admission.beforePayer = once(Deferred.succeed(bind, undefined).pipe(Effect.asVoid));
      const first = yield* submit(host, "first").pipe(Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      peer.push({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-a" } },
      });
      yield* waitUntil(() => binding);
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(first);
      expect(turnWith(world, "first")).toMatchObject({
        status: "running",
        providerTurnId: "turn-a",
        error: null,
      });
      peer.push({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-a",
          item: { id: "msg-1", type: "agentMessage", text: "the reply" },
        },
      });
      yield* waitUntil(() => world.items.get("msg-1")?.text === "the reply");
      peer.push({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-a", status: "completed" } },
      });
      yield* waitUntil(() => turnWith(world, "first")?.status === "completed");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("fails, and never queues again, a turn being sent when its process stops", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], { start: () => Promise.resolve() });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const caller = yield* submit(host, "first").pipe(Effect.exit, Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      yield* host.detachForHandOver(processId);
      yield* Fiber.join(caller);
      expect(turnWith(world, "first")).toMatchObject({
        status: "failed",
        error: TURN_DELIVERY_UNCONFIRMED,
      });
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect(
    "puts a claimed turn back in the queue, once, when Codex's output already ended",
    () => {
      const world = makeConversationWorld();
      const peer = makePipe(["turn-a"]);
      let claims = 0;
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        world.admission.afterClaim = Effect.gen(function* () {
          claims += 1;
          if (claims > 1) return;
          peer.end();
          while (yield* host.has(processId))
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
        });
        yield* submit(host, "first");
        expect(turnWith(world, "first")).toMatchObject({
          status: "queued",
          startedAt: null,
          error: null,
        });
        expect(claims).toBe(1);
        expect(turnStarts(peer)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("fails a turn Codex never confirmed with fixed words, and sends the next once", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (request, push) => {
        if (turnStarts(peer) > 1) push({ id: request.id, result: { turn: { id: "turn-b" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const first = yield* submit(host, "first").pipe(Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      const second = yield* submit(host, "second").pipe(Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "second") !== undefined);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Fiber.join(first)).toBe(
        via === "turn" ? null : "delivery not confirmed · Mend will not resend",
      );
      yield* Fiber.join(second);
      expect(turnWith(world, "first")).toMatchObject({
        status: "failed",
        providerTurnId: null,
        error: TURN_DELIVERY_UNCONFIRMED,
      });
      expect(turnWith(world, "second")).toMatchObject({
        status: "running",
        providerTurnId: "turn-b",
      });
      expect(turnStarts(peer)).toBe(2);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("leaves an unconfirmed turn running once Codex said it started", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], {
      start: (_request, push) => {
        push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-a" } } });
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const first = yield* submit(host, "first").pipe(Effect.forkChild);
      yield* waitUntil(() => turnWith(world, "first")?.providerTurnId === "turn-a");
      yield* TestClock.adjust("60 seconds");
      expect(yield* Fiber.join(first)).toBe(
        via === "turn"
          ? null
          : "sent as your next turn · you asked for a new turn · turn running · observed",
      );
      expect(turnWith(world, "first")).toMatchObject({ status: "running", error: null });
      peer.push({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-a", status: "completed" } },
      });
      yield* waitUntil(() => turnWith(world, "first")?.status === "completed");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("finishes sending a turn whose caller went away mid-send", () => {
    const world = makeConversationWorld();
    const held: Array<() => void> = [];
    const peer = makePipe([], {
      start: (request, push) => {
        held.push(() => push({ id: request.id, result: { turn: { id: "turn-a" } } }));
        return Promise.resolve();
      },
    });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const caller = yield* submit(host, "first").pipe(Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      yield* Fiber.interrupt(caller);
      for (const answer of held) answer();
      yield* waitUntil(() => turnWith(world, "first")?.providerTurnId === "turn-a");
      expect(turnWith(world, "first")?.status).toBe("running");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("keeps a turn a Stop cancelled while Codex had not answered", () => {
    const world = makeConversationWorld();
    const peer = makePipe([], { start: () => Promise.resolve() });
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const caller = yield* submit(host, "first").pipe(Effect.forkChild);
      yield* waitUntil(() => turnStarts(peer) === 1);
      const sending = turnWith(world, "first");
      if (sending === undefined) return expect.fail("the turn was not admitted");
      world.turns.set(
        sending.id,
        new AgentTurn({ ...sending, status: "cancelled", endedAt: now() }),
      );
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(caller);
      expect(turnWith(world, "first")).toMatchObject({ status: "cancelled", error: null });
      yield* host.detach(processId);
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
        expect(world.turns.get(orphan.id)).toMatchObject({
          status: "failed",
          error: TURN_DELIVERY_UNCONFIRMED,
        });
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

  it.live("rehydrates past an orphan a Stop cancelled while Mend failed it", () => {
    const world = makeConversationWorld();
    const seeded = world.seed("orphan");
    const orphan = new AgentTurn({ ...seeded, status: "running", startedAt: now() });
    world.turns.set(orphan.id, orphan);
    world.admission.beforeFail = once(
      Effect.sync(() =>
        world.turns.set(
          orphan.id,
          new AgentTurn({ ...orphan, status: "cancelled", endedAt: now() }),
        ),
      ),
    );
    const queued = world.seed("queued");
    const { pipe } = makePipe(["turn-b"]);
    const completed: string[] = [];
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* host.rehydrate({
        process: new SessionProcess({ ...agentProcess, providerSessionId: "thread-1" }),
        pipe,
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        launchedWithLoginOf: null,
        hooks: {
          onRequestChanged: () => Effect.void,
          onTurnCompleted: (turn) => Effect.sync(() => void completed.push(turn.id)),
        },
        highWater: 0n,
      });
      expect(world.turns.get(orphan.id)).toMatchObject({ status: "cancelled", error: null });
      expect(completed).toEqual([]);
      yield* waitUntil(() => world.turns.get(queued.id)?.providerTurnId === "turn-b");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

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
        const steering = yield* sendSteer(host, {
          turnId: target.id,
          sender: "user-1",
          input: "after replay",
        }).pipe(Effect.forkChild);
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
      const steering = yield* sendSteer(host, {
        turnId: ended.id,
        sender: "user-1",
        input: "after it ended",
      }).pipe(Effect.forkChild);
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
      const steering = yield* sendSteer(host, {
        turnId: target.id,
        sender: "user-1",
        input: "while replaying",
      }).pipe(Effect.forkChild);
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
        const receipt = yield* sendSteer(host, input);
        expect(receipt.delivery).toEqual({ _tag: "Accepted", evidence: "provider-acknowledged" });
        expect(receipt.input).toBe(input.input);
        expect(yield* sendSteer(host, { ...input })).toEqual(receipt);
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
        expect(yield* sendSteer(host, input)).toEqual(receipt);
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
        const receipt = yield* sendSteer(host, input);
        expect(receipt.delivery).toEqual({ _tag: "Queued", turnId: receipt.queuedTurnId, reason });
        expect(world.turns.get(receipt.queuedTurnId ?? turn.id)).toMatchObject({
          input: input.input,
          author: input.sender,
          status: "queued",
        });
        expect(yield* sendSteer(host, input)).toEqual(receipt);
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
        const receipt = yield* sendSteer(host, {
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

  if (via === "turn") {
    it.effect(
      "refuses unknown turns, non-senders, no sender, blank input and no live process before admission",
      () => {
        const world = makeConversationWorld();
        const turn = world.seed("start");
        return Effect.gen(function* () {
          const host = yield* ProtocolHost;
          const base = { turnId: turn.id, input: "words", sender: "user-1" };
          expect(
            (yield* sendSteer(host, { ...base, turnId: AgentTurnId.make("missing") }).pipe(
              Effect.flip,
            ))._tag,
          ).toBe("AgentTurnNotFoundError");
          expect((yield* sendSteer(host, { ...base, input: " \n\t" }).pipe(Effect.flip))._tag).toBe(
            "InvalidTurnSteerError",
          );
          expect(
            yield* sendSteer(host, { ...base, sender: "owner-1" }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "TurnSteerForbiddenError", reason: "not-sender" });
          expect((yield* sendSteer(host, base).pipe(Effect.flip))._tag).toBe(
            "ProtocolHostNotLiveError",
          );
          world.turns.set(turn.id, new AgentTurn({ ...turn, author: null }));
          expect(yield* sendSteer(host, base).pipe(Effect.flip)).toMatchObject({
            _tag: "TurnSteerForbiddenError",
            reason: "no-sender",
          });
          expect((yield* world.steerStore.listConversationTurns(sessionId))[0]?.steers).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
      },
    );
  }
  it.effect("keeps words as NotSent when a Stop detaches the process as they are queued", () => {
    const world = makeConversationWorld();
    const ended = world.seed("ended");
    world.turns.set(ended.id, new AgentTurn({ ...ended, status: "completed", endedAt: now() }));
    const peer = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.beforeSteerQueue = host.detach(processId);
      const receipt = yield* sendSteer(host, {
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

  it.effect("leaves a carried steer's turn to the successor that took it", () => {
    const world = makeConversationWorld();
    const ended = world.seed("ended");
    world.turns.set(ended.id, new AgentTurn({ ...ended, status: "completed", endedAt: now() }));
    const successor = new SessionProcess({
      ...agentProcess,
      id: SessionProcessId.make("process-2"),
    });
    const busy = world.seed("the successor's own turn");
    world.turns.set(
      busy.id,
      new AgentTurn({
        ...busy,
        processId: successor.id,
        status: "running",
        providerTurnId: "busy",
        startedAt: now(),
      }),
    );
    const peer = makePipe([]);
    const next = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterSteerQueue = Effect.gen(function* () {
        world.admission.afterSteerQueue = Effect.void;
        yield* host.detach(processId);
        yield* host
          .attach({
            process: successor,
            pipe: next.pipe,
            cwd: "/workspace/repo",
            permissionMode: "bypass",
            launchedWithLoginOf: "owner-1",
            hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
          })
          .pipe(Effect.orDie);
      });
      const receipt = yield* sendSteer(host, {
        turnId: ended.id,
        sender: "user-1",
        input: "carried",
      });
      expect(receipt.delivery).toEqual({
        _tag: "Queued",
        turnId: receipt.queuedTurnId,
        reason: "turn-ended",
      });
      expect(world.turns.get(receipt.queuedTurnId ?? ended.id)).toMatchObject({
        input: "carried",
        processId: successor.id,
        status: "queued",
      });
      yield* host.detach(successor.id);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer, [agentProcess, successor])));
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
      const attempt = yield* sendSteer(host, {
        turnId: ended.id,
        sender: "user-1",
        input: "lost in delivery",
      }).pipe(Effect.exit);
      expect(attempt._tag).toBe(via === "turn" ? "Failure" : "Success");
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
      const receipt = yield* sendSteer(host, input);
      for (const reuse of [
        ...(via === "turn" ? [{ ...input, turnId: other.id }] : []),
        { ...input, input: "other words" },
        { ...input, clientSteerId: input.clientSteerId.toUpperCase(), input: "other words" },
      ]) {
        expect(yield* sendSteer(host, reuse).pipe(Effect.flip)).toMatchObject({
          _tag: via === "turn" ? "TurnSteerKeyConflictError" : "MessageKeyConflictError",
        });
      }
      expect(
        yield* sendSteer(host, { ...input, clientSteerId: input.clientSteerId.toUpperCase() }),
      ).toEqual(receipt);
      expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(1);
      expect(
        (yield* world.steerStore.listConversationTurns(sessionId)).flatMap((each) => each.steers),
      ).toEqual([receipt]);
      expect(world.turns.size).toBe(2);
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
      const receipt = yield* sendSteer(host, input);
      expect(receipt.delivery).toEqual({ _tag: "Unknown", reason: "uncertain" });
      expect(yield* sendSteer(host, input)).toEqual(receipt);
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
      const receipt = yield* sendSteer(host, {
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
      const steering = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "during dispatch",
      }).pipe(Effect.forkChild);
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
      const admitted = yield* Deferred.make<void>();
      world.admission.afterSteerAdmit = Deferred.succeed(admitted, undefined).pipe(Effect.asVoid);
      const host = yield* ProtocolHost;
      const attaching = yield* attachCodex(host, peer.pipe).pipe(Effect.forkChild);
      yield* waitUntil(() => starts.length === 1);
      const steering = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "after bind timeout",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(admitted);
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
        const caller = yield* sendSteer(host, input).pipe(Effect.forkChild);
        yield* waitUntil(() => requests.length === 1);
        yield* host.interruptTurn(turn.id);
        expect(peer.interrupted).toEqual(["native"]);
        yield* Fiber.interrupt(caller);
        const sending = yield* sendSteer(host, input);
        expect(sending.delivery._tag).toBe("Sending");
        peer.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "native", status: "completed" } },
        });
        yield* waitUntil(() => world.turns.get(turn.id)?.status === "completed");
        expect(world.turns.get(next.id)?.status).toBe("queued");
        peer.push({ id: requests[0]?.id, result: { turnId: "native" } });
        yield* waitUntil(() => world.turns.get(next.id)?.providerTurnId === "next-native");
        const receipt = yield* sendSteer(host, input);
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
      const first = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "first",
      }).pipe(Effect.forkChild);
      yield* waitUntil(() => requests.length === 1);
      const second = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "second",
      }).pipe(Effect.forkChild);
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

  if (via === "message")
    it.effect("refuses words still waiting for admission when the last process stops", () => {
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
        const first = yield* sendSteer(host, {
          turnId: turn.id,
          sender: "user-1",
          input: "already admitted",
        }).pipe(Effect.forkChild);
        yield* waitUntil(() => requests.length === 1);
        const pending = yield* sendSteer(host, {
          turnId: turn.id,
          sender: "user-1",
          input: "still waiting",
          clientSteerId: crypto.randomUUID(),
        }).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("100 millis");
        yield* host.detach(processId);
        yield* Fiber.join(first);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProtocolHostNotLiveError" },
        });
        expect(
          (yield* world.steerStore.listConversationTurns(sessionId)).flatMap((row) =>
            row.steers.map((steer) => steer.input),
          ),
        ).toEqual(["already admitted"]);
        expect(requests).toHaveLength(1);
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
      const first = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "first",
      }).pipe(Effect.forkChild);
      yield* waitUntil(() => admissions === 1);
      const second = yield* sendSteer(host, {
        turnId: turn.id,
        sender: "user-1",
        input: "second",
      }).pipe(Effect.forkChild);
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
      const receipt = yield* sendSteer(host, {
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
        const receipt = yield* sendSteer(host, {
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
      peer.push(nativeCompleted("interrupted"));
      yield* waitUntil(() => completions.length === 1);
      peer.push(nativeCompleted("completed"));
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

  it.effect("projects a steered answer without waiting behind every superseded text delta", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      // The box persisted 553 preceding-answer updates at about 73 ms each. A ready
      // output burst must not charge the following answer once per stale snapshot.
      let writes = 0;
      world.admission.beforeUpsert = Effect.sync(() => {
        writes += 1;
      }).pipe(Effect.andThen(Effect.sleep("73 millis")));
      yield* sendSteer(host, { turnId: turn.id, sender: "user-1", input: "Only PINEAPPLE" });
      const push = (event: unknown) => peer.push({ type: "stream_event", event });
      push({ type: "message_start" });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < 550; i += 1)
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
      push({ type: "content_block_stop", index: 0 });
      yield* waitUntil(() => writes > 0);
      peer.push(aborted);
      peer.push(continued);
      push({ type: "message_start" });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PINEAPPLE" },
      });
      push({ type: "content_block_stop", index: 0 });
      peer.push(finished);
      for (let tick = 0; tick < 10; tick += 1) {
        // Let the SDK-shaped async iterable deliver ready chunks between clock ticks.
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        yield* TestClock.adjust("100 millis");
      }
      expect([...world.items.values()].some((item) => item.text === "PINEAPPLE")).toBe(true);
      expect(world.turns.get(turn.id)?.status).toBe("completed");
      expect([...world.items.values()].some((item) => item.text === "x".repeat(550))).toBe(true);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("keeps a long coalesced reply byte-exact before completing its turn", () => {
    const world = makeConversationWorld();
    const turn = world.seed("start");
    const peer = makeClaudePipe();
    const parts = Array.from({ length: 550 }, (_, i) => `${i}: Ελληνικά 👩🏽‍💻 e\u0301 \r\n`);
    const expected = parts.join("");
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      world.admission.beforeUpsert = Effect.sleep("73 millis");
      const push = (event: unknown) => peer.push({ type: "stream_event", event });
      push({ type: "message_start" });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (const text of parts)
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      push({ type: "content_block_stop", index: 0 });
      let completedAfterFinalSnapshot = false;
      world.admission.beforeComplete = Effect.sync(() => {
        const final = [...world.items.values()].find((item) => item.kind === "assistant-message");
        expect(new TextEncoder().encode(final?.text ?? "")).toEqual(
          new TextEncoder().encode(expected),
        );
        expect(final?.status).toBe("completed");
        expect(world.itemWrites.at(-1)?.providerOutputSeq).toBe(552n);
        expect(world.itemWrites.at(-1)?.providerEventIndex).toBe(0);
        expect(world.itemWrites.length).toBeLessThan(parts.length);
        completedAfterFinalSnapshot = true;
      });
      peer.push(finished);
      for (let tick = 0; tick < 10; tick += 1) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        yield* TestClock.adjust("100 millis");
      }
      expect(completedAfterFinalSnapshot).toBe(true);
      expect(world.turns.get(turn.id)?.status).toBe("completed");
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("flushes a pending final snapshot when detaching during a long reply", () => {
    const world = makeConversationWorld();
    world.seed("start");
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      const release = yield* Deferred.make<void>();
      let writes = 0;
      world.admission.beforeUpsert = Effect.sync(() => {
        writes += 1;
      }).pipe(Effect.andThen(Deferred.await(release)));
      const push = (event: unknown) => peer.push({ type: "stream_event", event });
      push({ type: "message_start" });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < 550; i += 1)
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
      push({ type: "content_block_stop", index: 0 });
      yield* waitUntil(() => writes > 0 && peer.pendingOutput() === 0);
      const detaching = yield* host.detachForHandOver(processId).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(detaching);
      expect([...world.items.values()].map((item) => item.text)).toEqual(["x".repeat(550)]);
      expect(world.itemWrites.at(-1)?.providerOutputSeq).toBe(552n);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("flushes the preceding item's final snapshot before an interleaved request", () => {
    const world = makeConversationWorld();
    world.seed("start");
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      world.admission.beforeUpsert = Effect.sleep("73 millis");
      const push = (event: unknown) => peer.push({ type: "stream_event", event });
      push({ type: "message_start" });
      push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < 550; i += 1)
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
      push({ type: "content_block_stop", index: 0 });
      let openedAfterFinalSnapshot = false;
      world.admission.beforeRequest = Effect.sync(() => {
        expect(
          [...world.items.values()].map((item) => ({ text: item.text, status: item.status })),
        ).toEqual([{ text: "x".repeat(550), status: "completed" }]);
        openedAfterFinalSnapshot = true;
      });
      peer.push({
        type: "control_request",
        request_id: "permission-after-text",
        request: {
          subtype: "can_use_tool",
          tool_name: "Edit",
          input: { file_path: "/workspace/repo/a.ts" },
        },
      });
      for (let tick = 0; tick < 10; tick += 1) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        yield* TestClock.adjust("100 millis");
      }
      expect(openedAfterFinalSnapshot).toBe(true);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("sends the next Claude turn after one whose start could not be recorded", () => {
    const world = makeConversationWorld();
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      world.admission.beforeBind = once(
        Effect.sync(() => void world.seed("second")).pipe(
          Effect.andThen(Effect.die("the bind failed")),
        ),
      );
      yield* submit(host, "first").pipe(Effect.exit);
      expect(turnWith(world, "first")).toMatchObject({
        status: "failed",
        error: TURN_DELIVERY_UNCONFIRMED,
      });
      yield* waitUntil(() => Deferred.isDoneUnsafe(world.requeued));
      peer.push(finished);
      yield* waitUntil(() => (turnWith(world, "second")?.providerTurnId ?? null) !== null);
      expect(turnWith(world, "second")?.status).toBe("running");
      expect(userFrames(peer)).toHaveLength(2);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("never ends a turn it has not sent when Claude ends one Mend failed", () => {
    const world = makeConversationWorld();
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      world.admission.beforeBind = once(Effect.die("the bind failed"));
      yield* submit(host, "first").pipe(Effect.exit);
      world.admission.afterClaim = once(
        Effect.sync(() => peer.push(finished)).pipe(
          Effect.andThen(
            Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
          ),
        ),
      );
      yield* submit(host, "second");
      expect(turnWith(world, "second")?.status).toBe("running");
      expect(turnWith(world, "second")?.providerTurnId).not.toBeNull();
      expect(userFrames(peer)).toHaveLength(2);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.live("never fails a turn Claude refused when putting it back failed once", () => {
    const world = makeConversationWorld();
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      const gate = yield* Deferred.make<void>();
      world.admission.beforeHarnessTurn = Deferred.await(gate);
      peer.push({ type: "system", subtype: "init", uuid: "init-1" });
      yield* Effect.sleep("30 millis");
      world.admission.beforeRequeue = once(Effect.die("the requeue failed"));
      const second = yield* submit(host, "second").pipe(Effect.exit);
      expect(turnWith(world, "second")).toMatchObject({ status: "cancelled", error: null });
      if (via === "turn") expect(Exit.isFailure(second)).toBe(true);
      else
        expect(second).toEqual(Exit.succeed("not sent · the turn was cancelled before it started"));
      expect(userFrames(peer)).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("fails a Claude turn whose write failed with fixed words, and sends the next", () => {
    const world = makeConversationWorld();
    const peer = makeClaudePipe();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachClaude(host, peer);
      peer.refuseNextTurn();
      expect(yield* submit(host, "first")).toBe(
        via === "turn" ? null : "delivery not confirmed · Mend will not resend",
      );
      expect(turnWith(world, "first")).toMatchObject({
        status: "failed",
        providerTurnId: null,
        error: TURN_DELIVERY_UNCONFIRMED,
      });
      yield* submit(host, "second");
      expect(turnWith(world, "second")?.status).toBe("running");
      expect(turnWith(world, "second")?.providerTurnId).not.toBeNull();
      expect(peer.sent.filter((line) => line.includes('"type":"user"'))).toHaveLength(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

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
        const receipt = yield* sendSteer(host, {
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
        const gap = yield* sendSteer(host, {
          turnId: turn.id,
          sender: "user-1",
          input: "one more",
        });
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
        const receipt = yield* sendSteer(host, {
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
      yield* sendSteer(host, { turnId: turn.id, sender: "user-1", input: "now" });
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
      yield* sendSteer(host, { turnId: turn.id, sender: "user-1", input: "now" });
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
        yield* sendSteer(host, {
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

const message = () => ({
  sessionId,
  sender: "user-1",
  input: MessageInput.make("  next words\n"),
  clientMessageId: ClientMessageId.make(crypto.randomUUID()),
  intent: "queue" as const,
});
describe("ProtocolHost message turn admission", () => {
  for (const status of [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const)
    it.effect(`reads the turn observed ${status} and replays without delivery`, () => {
      const world = makeConversationWorld();
      world.seed("hold queue");
      const peer = makePipe(["native"]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        world.admission.afterMessageAdmit = Effect.sync(() => {
          for (const [id, turn] of world.turns)
            if (turn.input === "  next words\n")
              world.turns.set(id, new AgentTurn({ ...turn, status }));
        });
        const input = message();
        const receipt = yield* host.sendMessage(input, { _tag: "Turn", reason: "queue-requested" });
        expect(receipt).toMatchObject({
          _tag: "Turn",
          turn: { status, input: input.input, author: input.sender },
        });
        expect(
          yield* host.sendMessage(input, { _tag: "Steer", turnId: AgentTurnId.make("changed") }),
        ).toEqual(receipt);
        expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
        expect(world.turns.size).toBe(2);
        yield* host.detach(processId);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    });

  it.effect("dispatches an idle conversation and returns its running observation", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["native"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const result = yield* host.sendMessage(message(), {
        _tag: "Turn",
        reason: "no-own-running-turn",
      });
      expect(result).toMatchObject({
        _tag: "Turn",
        turn: { status: "running", providerTurnId: "native" },
      });
      expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect(
    "reports an admitted turn as not sent when placement detaches, with words still readable",
    () => {
      const world = makeConversationWorld();
      const peer = makePipe([]);
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachCodex(host, peer.pipe);
        world.admission.afterMessageAdmit = host.detach(processId);
        const input = message();
        const result = yield* host.sendMessage(input, { _tag: "Turn", reason: "queue-requested" });
        expect(result).toMatchObject({
          _tag: "Turn",
          explanation: "not sent · the turn was cancelled before it started",
          turn: { status: "cancelled", input: input.input },
        });
        expect(yield* world.steerStore.messageByClientId(input)).toEqual(result);
        expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
    },
  );

  it.effect("withdraws a message turn whose dispatch failed before claiming it", () => {
    const logs: Array<string> = [];
    const logLayer = Logger.layer([
      Logger.make((options) => {
        logs.push(
          JSON.stringify([options.message, options.fiber.getRef(References.CurrentLogAnnotations)]),
        );
      }),
    ]);
    const world = makeConversationWorld();
    const peer = makePipe(["native"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      const input = message();
      // A query error's message carries its parameters, the person's words among them.
      world.admission.beforeClaim = Effect.die(new Error(`query failed · params: ${input.input}`));
      const receipt = yield* host.sendMessage(input, { _tag: "Turn", reason: "queue-requested" });
      expect(receipt).toMatchObject({
        _tag: "Turn",
        explanation: "not sent · the turn was cancelled before it started",
        turn: { status: "cancelled", input: input.input },
      });
      expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(0);
      expect(logs.some((line) => line.includes("not dispatched"))).toBe(true);
      expect(logs.filter((line) => line.includes(input.input.trim()))).toEqual([]);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)), Effect.provide(logLayer));
  });

  it.effect("never reports a claimed turn as sent when its dispatch fails", () => {
    const world = makeConversationWorld();
    const peer = makePipe(["native"]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      world.admission.afterClaim = Effect.suspend(() => {
        world.admission.afterClaim = Effect.void;
        return Effect.die("the claim's notification failed");
      });
      const input = message();
      const receipt = yield* host.sendMessage(input, { _tag: "Turn", reason: "queue-requested" });
      expect(receipt).toMatchObject({
        _tag: "Turn",
        explanation: "not sent · the turn was cancelled before it started",
        turn: { input: input.input, status: "cancelled", providerTurnId: null },
      });
      expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(0);
      const next = yield* host.sendMessage(message(), { _tag: "Turn", reason: "queue-requested" });
      expect(next).toMatchObject({ turn: { status: "running", providerTurnId: "native" } });
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("sends words as a new turn when the chosen turn vanished or changed sender", () => {
    const world = makeConversationWorld();
    const other = world.seed("another person's turn");
    world.turns.set(
      other.id,
      new AgentTurn({ ...other, author: "user-2", status: "running", startedAt: now() }),
    );
    const peer = makePipe([]);
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachCodex(host, peer.pipe);
      for (const turnId of [AgentTurnId.make("vanished"), other.id]) {
        const input = { ...message(), intent: "default" as const };
        expect(yield* host.sendMessage(input, { _tag: "Steer", turnId })).toMatchObject({
          _tag: "Turn",
          explanation: "sent as your next turn · you had no running turn in this session",
          turn: { input: input.input, author: input.sender, status: "queued" },
        });
      }
      expect(peer.written.filter((frame) => frame.method === "turn/steer")).toHaveLength(0);
      yield* host.detach(processId);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });

  it.effect("refuses a stopped or terminal-only session before storing a message", () => {
    const world = makeConversationWorld();
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      const input = message();
      expect(
        yield* host
          .sendMessage(input, { _tag: "Turn", reason: "queue-requested" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProtocolHostNotLiveError" });
      expect(yield* world.steerStore.messageByClientId(input)).toBeNull();
      expect(world.turns.size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(hostLayer(world.layer)));
  });
});
