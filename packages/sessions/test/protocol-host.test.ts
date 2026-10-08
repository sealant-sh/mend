import { describe, expect, it } from "@effect/vitest";
import {
  AgentConversationRepo,
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
import type { InteractiveSession } from "@sealant/sdk";
import { Deferred, Effect, Layer } from "effect";

import { ProtocolHost, ProtocolHostLive } from "../src/protocol-host.ts";

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
    beforeAdmit: Effect.Effect<void>;
    beforeHarnessTurn: Effect.Effect<void>;
  } = {
    stopping: false,
    beforeAdmit: Effect.void,
    beforeHarnessTurn: Effect.void,
  };
  const items = new Map<string, AgentItem>();
  const layer = Layer.succeed(AgentConversationRepo, {
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
    listTurns: () => Effect.succeed([...turns.values()]),
    openTurns: () =>
      Effect.succeed(
        [...turns.values()].filter((turn) => turn.status === "queued" || turn.status === "running"),
      ),
    claimNextTurn: () =>
      Effect.sync(() => {
        const all = [...turns.values()].toSorted((a, b) => a.ordinal - b.ordinal);
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
      }),
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
    completeTurn: (providerTurnId, _session, status) =>
      Effect.sync(() => {
        const turn = [...turns.values()].find(
          (candidate) => candidate.providerTurnId === providerTurnId,
        );
        return turn === undefined ? null : update(turn.id, { status, endedAt: now() });
      }),
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
  return { layer, turns, items, seed, admission };
};

const processesLayer = Layer.succeed(SessionProcessesRepo, {
  create: () => Effect.die("not in test"),
  byId: (id) => Effect.succeed(id === processId ? agentProcess : null),
  byLaunchCorrelation: () => Effect.succeed(null),
  listForSession: () => Effect.succeed([agentProcess]),
  listForSessions: () => Effect.succeed([agentProcess]),
  listForService: () => Effect.succeed([]),
  listLiveForWorkspace: () => Effect.succeed([]),
  listLive: () => Effect.succeed([]),
  listRecentServices: () => Effect.succeed([]),
  setStatus: () => Effect.void,
  setLabel: () => Effect.void,
  setProviderSessionId: () => Effect.void,
  markFirstOutput: () => Effect.succeed(false),
  setHostPort: () => Effect.void,
  setSealantSessionId: () => Effect.void,
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
  planRelaunch: () => Effect.void,
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
  executorAccessOf: () => Effect.succeed(null),
  requestRemoval: () => Effect.void,
  listRemovalRequested: () => Effect.succeed([]),
});

/**
 * A scripted codex app-server on the far side of a pipe session: answers the handshake, then
 * follows `turnScript` for each `turn/start` (an error entry rejects the turn, a string accepts
 * it with that provider turn id). Records every interrupt it receives.
 */
const makePipe = (turnScript: Array<{ error: string } | string>) => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const interrupted: string[] = [];
  const push = (value: unknown) => {
    pending.push({
      sequence: sequence++,
      data: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    });
    notify?.();
  };
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
      const request = message as { id?: number; method?: string; params?: { turnId?: string } };
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
          const step = turnScript[turnIndex++] ?? "turn-fallback";
          if (typeof step === "string") push({ id: request.id, result: { turn: { id: step } } });
          else push({ id: request.id, error: { message: step.error } });
          break;
        }
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
  return { pipe, interrupted };
};

/** A Claude Code on the far side of a pipe: records what Mend sends, says what the test pushes. */
const makeClaudePipe = () => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const sent: Array<string> = [];
  const push = (value: unknown) => {
    pending.push({
      sequence: sequence++,
      data: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    });
    notify?.();
  };
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
  return { pipe, push, sent };
};

const hostLayer = (conversation: Layer.Layer<AgentConversationRepo>) =>
  ProtocolHostLive.pipe(
    Layer.provide(conversation),
    Layer.provide(processesLayer),
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
      // The accepted turn records the login it ran on: the one the workspace launched with, its
      // account named and its id unknown. A turn the harness refused ran on nobody's.
      expect(world.turns.get(second.id)).toMatchObject({
        author: "user-1",
        billedUserId: "owner-1",
        billedAccountId: null,
        billedAccountName: "default",
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
          billedAccountName: "default",
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
});
