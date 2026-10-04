import {
  AgentProtocolError,
  ClaudeAdapter,
  CodexAdapter,
  type AgentRehydrateOptions,
  type AgentSession,
} from "@mend/agent-protocol";
import {
  AgentConversationRepo,
  type AgentRequestAlreadyResolvedError,
  type AgentRequestNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import type { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentInputAnswers,
  AgentRequest,
  AgentTurn,
  SessionProcess,
  TurnPayer,
} from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import type { InteractiveSession } from "@sealant/sdk";
import { Deferred, Effect, Layer, Schema, Scope, Stream } from "effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

/** A live protocol process or provider request cannot be addressed by this Mend process. */
export class ProtocolHostNotLiveError extends Schema.TaggedErrorClass<ProtocolHostNotLiveError>()(
  "ProtocolHostNotLiveError",
  { processId: Schema.String },
) {}

/** Hooks that return protocol observations to the owning session engine. */
export interface ProtocolHostHooks {
  readonly onRequestChanged: (sessionId: SessionId) => Effect.Effect<void>;
  readonly onTurnCompleted: (turn: AgentTurn) => Effect.Effect<void>;
}

/** Options needed to initialize a protocol adapter after the pipe process starts. */
export interface AttachProtocolProcessInput {
  readonly process: SessionProcess;
  readonly pipe: InteractiveSession;
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode: "bypass" | "ask";
  readonly hooks: ProtocolHostHooks;
  /**
   * Whose login the workspace launched with (docs/adr/0013-whoever-sends-a-turn-pays.md): the
   * session owner's, or a capture-mode join's lease holder's. Null when Mend cannot say.
   */
  readonly launchedWithLoginOf: string | null;
}

/**
 * Re-attach to a pipe that survived a Mend restart (restart policy v2). The
 * harness never observed the disconnect; the adapter rebuilds its correlation
 * state from the durable record plus a full replay of the recorded output.
 */
export interface RehydrateProtocolProcessInput extends AttachProtocolProcessInput {
  /** Recorded output high water at probe time; dispatch stays gated until replay passes it. */
  readonly highWater: bigint;
}

interface ProviderEventPosition {
  readonly outputSequence: bigint;
  readonly eventIndex: number;
}

interface HostedProcess {
  readonly process: SessionProcess;
  readonly adapter: AgentSession;
  readonly pipe: InteractiveSession;
  readonly hooks: ProtocolHostHooks;
  readonly dispatchPermit: Semaphore.Semaphore;
  readonly abort: AbortController;
  /** Non-null while a rehydrate replay is still behind its high water — dispatch waits on it. */
  readonly gate: Deferred.Deferred<void> | null;
  /**
   * The login the workspace holds (docs/adr/0013, "The host remembers what the workspace holds"):
   * the one it launched with, until a switch writes another.
   */
  holds: TurnPayer;
}

/**
 * The login a conversation's workspace launches with: Mend creates it with `{ claude: true }` or
 * `{ codex: true }`, the launching person's account named `default`. Core does not report that
 * account's id at create, so it stays unknown.
 */
const launchLogin = (userId: string | null): TurnPayer => ({
  userId,
  accountId: null,
  accountName: userId === null ? null : "default",
});

/**
 * Make the workspace hold the login the next turn runs on, and say whose it is (docs/adr/0013,
 * "The switch sits in dispatch"). Until Core can write another login into a live workspace, every
 * turn runs on the one the workspace holds; the switch replaces this with the turn's sender's.
 */
const loginForTurn = (entry: HostedProcess): Effect.Effect<TurnPayer> =>
  Effect.succeed(entry.holds);

/**
 * Process-local ownership of live protocol adapters. Durable turns, items, requests, and replay
 * identities stay in AgentConversationRepo; this service owns only byte streams and pending calls.
 */
export class ProtocolHost extends Context.Service<
  ProtocolHost,
  {
    readonly attach: (
      input: AttachProtocolProcessInput,
    ) => Effect.Effect<void, SealantPlatformError>;
    /** Boot-time re-attachment to a surviving pipe; a no-op when the process is already hosted. */
    readonly rehydrate: (
      input: RehydrateProtocolProcessInput,
    ) => Effect.Effect<void, SealantPlatformError>;
    readonly submitTurn: (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId?: string | null,
    ) => Effect.Effect<AgentTurn, ProtocolHostNotLiveError>;
    readonly interruptTurn: (turnId: AgentTurnId) => Effect.Effect<void, ProtocolHostNotLiveError>;
    readonly respondRequest: (
      request: AgentRequest,
      response:
        | { readonly decision: AgentApprovalDecision; readonly answers?: never }
        | { readonly answers: AgentInputAnswers; readonly decision?: never },
      decidedBy: string,
    ) => Effect.Effect<
      AgentRequest,
      ProtocolHostNotLiveError | AgentRequestNotFoundError | AgentRequestAlreadyResolvedError
    >;
    readonly detach: (processId: SessionProcessId) => Effect.Effect<void>;
    readonly has: (processId: SessionProcessId) => Effect.Effect<boolean>;
  }
>()("@mend/sessions/ProtocolHost") {}

const adapterFor = (harness: string | null) =>
  harness === "claude" ? ClaudeAdapter : CodexAdapter;

const toPlatformError = (operation: string, cause: unknown): SealantPlatformError =>
  new SealantPlatformError({
    code: "agent_protocol_failed",
    status: null,
    message: `Agent protocol ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

export const ProtocolHostLive: Layer.Layer<
  ProtocolHost,
  never,
  AgentConversationRepo | SessionProcessesRepo | SessionsRepo
> = Layer.effect(
  ProtocolHost,
  Effect.gen(function* () {
    const conversations = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const sessions = yield* SessionsRepo;
    const scope = yield* Effect.scope;
    const hosted = new Map<SessionProcessId, HostedProcess>();

    const lookupTurn = Effect.fn("ProtocolHost.lookupTurn")(function* (
      sessionId: SessionId,
      providerTurnId: string,
    ) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const turn = yield* conversations.byProviderTurnId(sessionId, providerTurnId);
        if (turn !== null) return turn;
        yield* Effect.sleep("10 millis");
      }
      return null;
    });

    const dispatchNext = (entry: HostedProcess): Effect.Effect<void> =>
      entry.dispatchPermit.withPermit(
        Effect.gen(function* () {
          // A rehydrate replay still behind its high water must finish before
          // any queued turn reaches the harness: the adapter's present is not
          // yet the harness's present. Waiting inside the permit is safe — the
          // gate resolves from an independent watcher fiber.
          if (entry.gate !== null) yield* Deferred.await(entry.gate);
          // Drain until one turn is accepted or the queue is empty. A rejected turn (bad model,
          // transient send failure) must not strand the turns queued behind it: nothing else
          // re-enters dispatch until the NEXT accepted turn completes.
          for (;;) {
            const turn = yield* conversations.claimNextTurn(entry.process.id);
            if (turn === null) return;
            const payer = yield* loginForTurn(entry);
            const sent = yield* entry.adapter.sendTurn(turn.input).pipe(Effect.result);
            if (sent._tag === "Failure" && sent.failure._tag === "AgentTurnBusyError") {
              // The harness is in a turn of its own; that turn's end dispatches this one.
              yield* conversations.requeueClaimedTurn(turn.id);
              return;
            }
            if (sent._tag === "Failure") {
              yield* conversations.failTurn(turn.id, String(sent.failure)).pipe(Effect.orDie);
              const failed = yield* conversations.byTurnId(turn.id);
              if (failed === null) return yield* Effect.die(`Turn ${turn.id} disappeared`);
              yield* entry.hooks.onTurnCompleted(failed);
              if (!hosted.has(entry.process.id)) return;
              continue;
            }
            yield* conversations.setTurnPayer(turn.id, payer).pipe(Effect.orDie);
            yield* conversations.setProviderTurnId(turn.id, sent.success).pipe(Effect.orDie);
            return;
          }
        }),
      );

    const projectEvent = Effect.fn("ProtocolHost.projectEvent")(function* (
      entry: HostedProcess,
      event: AgentEvent,
      position: ProviderEventPosition,
    ) {
      switch (event._tag) {
        case "session.ready":
          if (event.providerSessionId !== null) {
            yield* processes.setProviderSessionId(entry.process.id, event.providerSessionId);
            yield* sessions.setProviderSessionId(entry.process.sessionId, event.providerSessionId);
          }
          return;
        case "turn.started":
          yield* conversations.bindRunningProviderTurn(
            entry.process.sessionId,
            entry.process.id,
            event.providerTurnId,
          );
          return;
        case "harness-turn.started": {
          const opened = yield* conversations.openHarnessTurn(
            entry.process.sessionId,
            entry.process.id,
            event.providerTurnId,
            event.reason,
            // Nobody sent it: it runs on whatever login the workspace holds.
            entry.holds,
          );
          if (opened === null) {
            yield* Effect.logWarning(
              "protocol host: the harness opened a turn while a sent turn still runs",
            ).pipe(
              Effect.annotateLogs({
                processId: entry.process.id,
                providerTurnId: event.providerTurnId,
              }),
            );
          }
          return;
        }
        case "turn.completed": {
          yield* conversations.bindRunningProviderTurn(
            entry.process.sessionId,
            entry.process.id,
            event.providerTurnId,
          );
          const turn = yield* conversations.completeTurn(
            event.providerTurnId,
            entry.process.sessionId,
            event.status,
            event.usage,
            event.error,
          );
          if (turn === null) return;
          yield* conversations.cancelOpenForTurn(turn.id);
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          yield* entry.hooks.onTurnCompleted(turn);
          yield* Effect.forkIn(dispatchNext(entry), scope);
          return;
        }
        case "item.updated": {
          const turn = yield* lookupTurn(entry.process.sessionId, event.item.providerTurnId);
          // A background task outlives the turn that started it and keeps reporting there.
          if (turn === null || (turn.status !== "running" && event.item.kind !== "task")) return;
          yield* conversations.upsertItem({
            ...event.item,
            sessionId: entry.process.sessionId,
            processId: entry.process.id,
            turnId: turn.id,
            providerOutputSeq: position.outputSequence,
            providerEventIndex: position.eventIndex,
          });
          return;
        }
        case "content.delta":
          // Adapters also emit an idempotent whole-item update after every delta. Persisting only
          // that update prevents replay from appending the same fragment twice.
          return;
        case "request.opened": {
          const turn = yield* lookupTurn(entry.process.sessionId, event.request.providerTurnId);
          // A request that races turn completion must not re-open after cancelOpenForTurn ran;
          // the adapter's own close/cancel path answers the held response.
          if (turn === null || turn.status !== "running") return;
          yield* conversations.openRequest({
            ...event.request,
            sessionId: entry.process.sessionId,
            processId: entry.process.id,
            turnId: turn.id,
          });
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          return;
        }
        case "request.resolved":
          yield* conversations.resolveProviderRequest(entry.process.id, event.providerRequestId);
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          return;
        case "runtime.warning":
          yield* Effect.logWarning(event.message).pipe(
            Effect.annotateLogs({ processId: entry.process.id, harness: entry.process.harness }),
          );
          return;
        case "runtime.error":
          hosted.delete(entry.process.id);
          // Close the adapter first: it answers held provider requests and stops the output
          // fiber, so no request.opened can land after the cancel sweep below.
          yield* entry.adapter.close().pipe(Effect.ignore);
          yield* conversations.cancelOpenForProcess(entry.process.id);
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          yield* Effect.tryPromise({
            try: () => entry.pipe.close(),
            catch: () => new Error("protocol pipe close failed"),
          }).pipe(Effect.ignore);
          yield* Effect.logError(event.message).pipe(
            Effect.annotateLogs({ processId: entry.process.id, harness: entry.process.harness }),
          );
      }
    });

    const attachInternal = Effect.fn("ProtocolHost.attachInternal")(function* (
      input: AttachProtocolProcessInput,
      rehydrateInput: (AgentRehydrateOptions & { readonly highWater: bigint }) | null,
    ) {
      const abort = new AbortController();
      // Always replay from 0: delta text accumulates in the adapter's in-memory items, so a
      // partial replay would rebuild an item from its tail alone. Replaying everything is
      // idempotent — upsertItem skips positions at or below what a row already carries — and
      // rebuilds the accumulation state exactly. (Today attach only ever runs at process
      // creation; boot ends live protocol rows rather than re-attaching.)
      let currentOutputSequence = 0n;
      let currentEventIndex = 0;
      const output = Stream.fromAsyncIterable(
        input.pipe.output({ from: 0n, signal: abort.signal }),
        (cause) => toPlatformError("output", cause),
      ).pipe(
        // One pipe chunk per stream chunk (fromAsyncIterable emits element-wise); the rechunk
        // pins that so the position mutation stays aligned with the element being handled.
        Stream.rechunk(1),
        Stream.map((chunk) => {
          currentOutputSequence = chunk.sequence;
          currentEventIndex = 0;
          return chunk.data;
        }),
      );
      const transport = {
        send: (bytes: Uint8Array) =>
          Effect.tryPromise({
            try: () => input.pipe.send(bytes),
            catch: (cause) =>
              new AgentProtocolError({
                adapter: input.process.harness === "claude" ? "claude" : "codex",
                operation: "transport.send",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        output: output.pipe(
          Stream.mapError(
            (cause) =>
              new AgentProtocolError({
                adapter: input.process.harness === "claude" ? "claude" : "codex",
                operation: "transport.output",
                message: cause.message,
                cause,
              }),
          ),
        ),
        close: () => Effect.sync(() => abort.abort()),
      };
      let activeEntry: HostedProcess | null = null;
      let flushed = false;
      const pendingEvents: Array<{
        readonly event: AgentEvent;
        readonly position: ProviderEventPosition;
      }> = [];
      const onEvent = (event: AgentEvent): Effect.Effect<void> => {
        const position = {
          outputSequence: currentOutputSequence,
          eventIndex: currentEventIndex,
        } satisfies ProviderEventPosition;
        currentEventIndex += 1;
        // Buffer until the flush below drains the queue: an event landing between
        // `activeEntry = entry` and the drain must not jump ahead of buffered ones.
        if (activeEntry === null || !flushed) {
          return Effect.sync(() => pendingEvents.push({ event, position })).pipe(Effect.asVoid);
        }
        return projectEvent(activeEntry, event, position);
      };
      const adapter = yield* adapterFor(input.process.harness)
        .start(transport, {
          cwd: input.cwd,
          providerSessionId: input.process.providerSessionId ?? undefined,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          onEvent,
          rehydrate:
            rehydrateInput === null
              ? undefined
              : {
                  replayProviderTurnIds: rehydrateInput.replayProviderTurnIds,
                  resolvedProviderRequestIds: rehydrateInput.resolvedProviderRequestIds,
                },
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => toPlatformError("start", cause)),
        );
      const gate = rehydrateInput === null ? null : yield* Deferred.make<void>();
      const entry: HostedProcess = {
        process: input.process,
        adapter,
        pipe: input.pipe,
        hooks: input.hooks,
        dispatchPermit: Semaphore.makeUnsafe(1),
        abort,
        gate,
        holds: launchLogin(input.launchedWithLoginOf),
      };
      activeEntry = entry;
      hosted.set(input.process.id, entry);
      while (pendingEvents.length > 0) {
        const buffered = pendingEvents.splice(0);
        yield* Effect.forEach(
          buffered,
          ({ event, position }) => projectEvent(entry, event, position),
          { discard: true },
        );
      }
      // Synchronous with the emptiness check above: nothing can enqueue between it and this.
      flushed = true;
      if (rehydrateInput === null || gate === null) {
        yield* dispatchNext(entry);
        return;
      }
      // Rehydrate returns immediately; a watcher opens the gate once replay
      // passes the probe-time high water (or the stream ends and the entry is
      // gone), then runs the dispatch every blocked caller queued behind.
      // `currentOutputSequence` advances in the stream's map — another fiber.
      const replayCaughtUp = () => currentOutputSequence >= rehydrateInput.highWater;
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (hosted.get(input.process.id) === entry && !replayCaughtUp()) {
            yield* Effect.sleep("100 millis");
          }
          // The last chunk's projection may still be in flight when the
          // sequence catches up; a short settle keeps dispatch behind it.
          yield* Effect.sleep("50 millis");
          yield* Deferred.succeed(gate, undefined);
          if (hosted.get(input.process.id) === entry) yield* dispatchNext(entry);
        }),
        scope,
      );
    });

    const attach = Effect.fn("ProtocolHost.attach")(function* (input: AttachProtocolProcessInput) {
      yield* attachInternal(input, null);
    });

    const rehydrate = Effect.fn("ProtocolHost.rehydrate")(function* (
      input: RehydrateProtocolProcessInput,
    ) {
      if (hosted.has(input.process.id)) return;
      const turns = yield* conversations.listTurns(input.process.sessionId);
      const processTurns = turns.filter((turn) => turn.processId === input.process.id);
      // A turn dispatched but never acknowledged (the restart landed between the
      // adapter send and setProviderTurnId) cannot be correlated with the
      // replay — fail it honestly rather than guess.
      for (const orphan of processTurns) {
        if (orphan.status !== "running" || orphan.providerTurnId !== null) continue;
        yield* conversations
          .failTurn(orphan.id, "Mend restarted before the turn was acknowledged.")
          .pipe(Effect.orDie);
        const failed = yield* conversations.byTurnId(orphan.id);
        if (failed !== null) yield* input.hooks.onTurnCompleted(failed);
      }
      // In the order they started, not their ordinals: a turn the harness opened on its own
      // takes the next ordinal while a turn queued before it waits behind it.
      const replayProviderTurnIds = processTurns
        .toSorted(
          (a, b) =>
            (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0) || a.ordinal - b.ordinal,
        )
        .flatMap((turn) => (turn.providerTurnId === null ? [] : [turn.providerTurnId]));
      const requests = yield* conversations.listRequests(input.process.sessionId, false);
      const resolvedProviderRequestIds = new Set(
        requests
          .filter(
            (request) => request.processId === input.process.id && request.status !== "pending",
          )
          .map((request) => request.providerRequestId),
      );
      // A response caught mid-delivery reads `sending` forever; make it answerable again.
      yield* conversations.resetSendingResponses(input.process.id);
      yield* attachInternal(input, {
        replayProviderTurnIds,
        resolvedProviderRequestIds,
        highWater: input.highWater,
      });
    });

    const submitTurn = Effect.fn("ProtocolHost.submitTurn")(function* (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId: string | null = null,
    ) {
      const rows = yield* processes.listForSession(sessionId);
      const process = rows.findLast(
        (candidate) =>
          candidate.kind === "agent-protocol" &&
          candidate.exitedAt === null &&
          hosted.has(candidate.id),
      );
      if (process === undefined) {
        return yield* new ProtocolHostNotLiveError({ processId: sessionId });
      }
      // A stop that began after the host was read above is not raced: the idle stop's claim and
      // this admission take the same lock, and a claimed session refuses the turn. The next
      // message resumes the session instead.
      const turn = yield* conversations
        .submitTurn(sessionId, process.id, input, author, launchCorrelationId)
        .pipe(
          Effect.catchTag("SessionStoppingError", () =>
            Effect.fail(new ProtocolHostNotLiveError({ processId: process.id })),
          ),
        );
      const entry = hosted.get(process.id);
      if (entry === undefined) {
        // Detached while the turn was being queued (a user stop does not take the lock): nothing
        // will ever dispatch it, so it is cancelled and refused, never acknowledged.
        yield* conversations.cancelOpenForTurn(turn.id);
        return yield* new ProtocolHostNotLiveError({ processId: process.id });
      }
      yield* dispatchNext(entry);
      return turn;
    });

    const interruptTurn = Effect.fn("ProtocolHost.interruptTurn")(function* (turnId: AgentTurnId) {
      const turn = yield* conversations.byTurnId(turnId);
      if (turn === null) return yield* new ProtocolHostNotLiveError({ processId: turnId });
      // A queued turn never reached the harness: cancel the row and leave the running turn
      // alone. The adapters can only interrupt their current turn, so reaching them for a
      // queued or already-ended turn would stop the wrong work.
      if (turn.status === "queued") {
        yield* conversations.cancelOpenForTurn(turn.id);
        const entry = hosted.get(turn.processId);
        if (entry !== undefined) yield* entry.hooks.onRequestChanged(turn.sessionId);
        return;
      }
      if (turn.status !== "running") return;
      const entry = hosted.get(turn.processId);
      if (entry === undefined) {
        return yield* new ProtocolHostNotLiveError({ processId: turn.processId });
      }
      yield* entry.adapter
        .interrupt()
        .pipe(Effect.mapError(() => new ProtocolHostNotLiveError({ processId: turn.processId })));
    });

    const respondRequest = Effect.fn("ProtocolHost.respondRequest")(function* (
      request: AgentRequest,
      response:
        | { readonly decision: AgentApprovalDecision; readonly answers?: never }
        | { readonly answers: AgentInputAnswers; readonly decision?: never },
      decidedBy: string,
    ) {
      const entry = hosted.get(request.processId);
      if (entry === undefined) {
        return yield* new ProtocolHostNotLiveError({ processId: request.processId });
      }
      yield* conversations.prepareRequestResponse(request.id, response, decidedBy);
      const sendResponse =
        "decision" in response
          ? entry.adapter.respond(request.providerRequestId, response.decision)
          : entry.adapter.respondInput(request.providerRequestId, response.answers);
      yield* sendResponse.pipe(
        Effect.mapError(() => new ProtocolHostNotLiveError({ processId: request.processId })),
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* conversations.failRequestResponse(request.id);
            // The turn may have completed while the send was in flight; its cancel sweep
            // skipped this row (delivery read `sending`). Sweep again now that it reads
            // `failed`, or the pending row pins the session at `waiting` forever.
            const turn = yield* conversations.byTurnId(request.turnId);
            if (turn !== null && turn.status !== "running" && turn.status !== "queued") {
              yield* conversations.cancelOpenForTurn(request.turnId);
            }
            yield* entry.hooks.onRequestChanged(request.sessionId);
          }),
        ),
      );
      const resolved = yield* conversations.completeRequestResponse(request.id);
      yield* entry.hooks.onRequestChanged(request.sessionId);
      return resolved;
    });

    const detach = Effect.fn("ProtocolHost.detach")(function* (processId: SessionProcessId) {
      const entry = hosted.get(processId);
      if (entry === undefined) return;
      hosted.delete(processId);
      yield* entry.adapter.close();
      entry.abort.abort();
    });

    return ProtocolHost.of({
      attach,
      rehydrate,
      submitTurn,
      interruptTurn,
      respondRequest,
      detach,
      has: (processId) => Effect.succeed(hosted.has(processId)),
    });
  }),
);
