import type { AgentSession } from "@mend/agent-protocol";
import { type AgentConversationRepo, AgentTurnNotFoundError } from "@mend/db";
import { type AgentTurnId, failureName, type SessionProcessId } from "@mend/domain";
import {
  turnSteerSender,
  TurnSteerForbiddenError,
  type SendMessageInput,
  type AgentTurn,
  type AgentTurnSteer,
  type SessionProcess,
  type TurnSteerQueueReason,
} from "@mend/domain/workbench";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, type Scope } from "effect";
import type * as Semaphore from "effect/Semaphore";

export { TurnSteerForbiddenError } from "@mend/domain/workbench";

export class InvalidTurnSteerError extends Schema.TaggedError<InvalidTurnSteerError>()(
  "InvalidTurnSteerError",
  { message: Schema.String },
) {}

export class TurnSteerKeyConflictError extends Schema.TaggedError<TurnSteerKeyConflictError>()(
  "TurnSteerKeyConflictError",
  { clientSteerId: Schema.String, message: Schema.String },
) {}

export interface SteerTurnInput {
  readonly turnId: AgentTurnId;
  readonly input: string;
  readonly sender: string;
  readonly clientSteerId?: string | null;
}

const STEER_REPLAY_WAIT = "5 seconds";

export interface SteerableProcess {
  readonly process: SessionProcess;
  readonly adapter: AgentSession;
  readonly steerPermit: Semaphore.Semaphore;
  readonly steerGate: Deferred.Deferred<void> | null;
  readonly stopping: boolean;
  readonly handingOverTo: string | null;
  steerHolds: number;
}

export interface TurnSteeringHost<P extends SteerableProcess, E> {
  readonly conversations: AgentConversationRepo["Service"];
  readonly hosted: (processId: SessionProcessId) => P | undefined;
  /** `placed` also accepts a conversation between processes, which queues the words. */
  readonly requireLive: (turn: AgentTurn, needs: "hosted" | "placed") => Effect.Effect<void, E>;
  readonly carryToNextTurn: (
    steer: AgentTurnSteer,
    reason: TurnSteerQueueReason,
  ) => Effect.Effect<AgentTurnSteer>;
  readonly released: (entry: P) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}

type SteerTarget<P> =
  | { readonly _tag: "Carry"; readonly reason: TurnSteerQueueReason }
  | { readonly _tag: "Running"; readonly turn: AgentTurn; readonly entry: P };

export const openSteerGate = (
  gate: Deferred.Deferred<void>,
  projected: () => boolean,
  stillHosted: () => boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (stillHosted() && !projected()) {
      yield* Effect.sleep("100 millis");
    }
    yield* Deferred.succeed(gate, undefined);
  });

export const makeTurnSteering = <P extends SteerableProcess, E>(host: TurnSteeringHost<P, E>) => {
  const { conversations } = host;

  const steerTarget = (
    steer: AgentTurnSteer,
    entry: P | undefined,
  ): Effect.Effect<SteerTarget<P>> =>
    conversations.byTurnId(steer.turnId).pipe(
      Effect.map((turn): SteerTarget<P> => {
        if (turn === null || turn.status !== "running") {
          return {
            _tag: "Carry",
            reason: turn?.status === "queued" ? "not-running" : "turn-ended",
          };
        }
        if (
          entry === undefined ||
          entry.stopping ||
          host.hosted(entry.process.id) !== entry ||
          turn.processId !== entry.process.id
        ) {
          return { _tag: "Carry", reason: "not-running" };
        }
        if (entry.handingOverTo !== null) return { _tag: "Carry", reason: "handing-over" };
        return { _tag: "Running", turn, entry };
      }),
    );

  const sendSteer = Effect.fn("ProtocolHost.sendSteer")(function* (
    steer: AgentTurnSteer,
    entry: P,
  ) {
    let turn = yield* conversations.byTurnId(steer.turnId);
    for (
      let attempt = 0;
      turn?.status === "running" && turn.providerTurnId === null && attempt < 60;
      attempt += 1
    ) {
      if (entry.stopping || host.hosted(entry.process.id) !== entry) break;
      yield* Effect.sleep("50 millis");
      turn = yield* conversations.byTurnId(steer.turnId);
    }
    const target = yield* steerTarget(steer, entry);
    if (target._tag === "Carry") return yield* host.carryToNextTurn(steer, target.reason);
    const providerTurnId = target.turn.providerTurnId;
    if (providerTurnId === null) return yield* host.carryToNextTurn(steer, "not-acknowledged");
    if (!entry.adapter.activeSteering.supported)
      return yield* host.carryToNextTurn(steer, "unsupported");
    const result = yield* entry.adapter
      .steer({ id: steer.id, expectedTurnId: providerTurnId, input: steer.input })
      .pipe(Effect.result);
    if (result._tag === "Success") {
      return yield* conversations.settleTurnSteer(steer.id, {
        _tag: "Accepted",
        evidence:
          result.success._tag === "ProviderAcknowledged"
            ? "provider-acknowledged"
            : "transport-written",
      });
    }
    const error = result.failure;
    if (error._tag === "AgentSteerRefusedError")
      return yield* host.carryToNextTurn(steer, error.reason);
    if (error.certainty === "not-written") return yield* host.carryToNextTurn(steer, "not-written");
    return yield* conversations.settleTurnSteer(steer.id, {
      _tag: "Unknown",
      reason: "uncertain",
    });
  });

  const deliverSteer = Effect.fn("ProtocolHost.deliverSteer")(function* (
    steer: AgentTurnSteer,
    entry: P | undefined,
  ) {
    let target = yield* steerTarget(steer, entry);
    if (target._tag === "Carry") return yield* host.carryToNextTurn(steer, target.reason);
    const gate = target.entry.steerGate;
    if (gate !== null) {
      const ready = yield* Deferred.await(gate).pipe(Effect.timeoutOption(STEER_REPLAY_WAIT));
      if (Option.isNone(ready)) return yield* host.carryToNextTurn(steer, "replaying");
      target = yield* steerTarget(steer, entry);
      if (target._tag === "Carry") return yield* host.carryToNextTurn(steer, target.reason);
    }
    const running = target.entry;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        running.steerHolds += 1;
      }),
      () => sendSteer(steer, running),
      () =>
        Effect.suspend(() => {
          running.steerHolds -= 1;
          return host.released(running);
        }),
    );
  });

  const deliverNewSteer = (steer: AgentTurnSteer, entry: P | undefined) =>
    deliverSteer(steer, entry).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? conversations
              .settleTurnSteer(steer.id, { _tag: "Unknown", reason: "failed" })
              .pipe(Effect.exit, Effect.asVoid)
          : Effect.void,
      ),
    );

  const steerMessage = Effect.fn("ProtocolHost.steerMessage")(function* (
    input: SendMessageInput,
    turnId: AgentTurnId,
  ) {
    const turn = yield* conversations.byTurnId(turnId);
    if (turn === null) return yield* new AgentTurnNotFoundError({ turnId });
    const entry = host.hosted(turn.processId);
    const attempt = Effect.gen(function* () {
      yield* host.requireLive(turn, "placed");
      const admitted = yield* conversations.admitSteerMessage(input, turnId);
      if (admitted._tag === "Replay") return admitted.result;
      const { steer, messageId } = admitted.result;
      yield* deliverNewSteer(steer, entry).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("protocol host: a message's steer delivery failed").pipe(
                Effect.annotateLogs({ steerId: steer.id, failure: failureName(cause) }),
              ),
        ),
      );
      return yield* conversations.messageById(messageId);
    });
    const fiber = yield* Effect.forkIn(
      entry === undefined ? attempt : entry.steerPermit.withPermit(attempt),
      host.scope,
    );
    return yield* Fiber.join(fiber);
  });

  const steerTurn = Effect.fn("ProtocolHost.steerTurn")(function* (input: SteerTurnInput) {
    if (input.input.trim().length === 0)
      return yield* new InvalidTurnSteerError({ message: "A steer must contain words." });
    const turn = yield* conversations.byTurnId(input.turnId);
    if (turn === null) return yield* new AgentTurnNotFoundError({ turnId: input.turnId });
    const sender = turnSteerSender(turn);
    if (sender !== input.sender)
      return yield* new TurnSteerForbiddenError({
        turnId: turn.id,
        reason: sender === null ? "no-sender" : "not-sender",
        message:
          sender === null
            ? "This turn has no recorded sender."
            : "Only this turn's sender may steer it.",
      });
    const clientSteerId = input.clientSteerId?.toLowerCase() ?? null;
    const firstReceiptOrConflict = (existing: AgentTurnSteer) =>
      existing.turnId === turn.id && existing.input === input.input
        ? Effect.succeed(existing)
        : Effect.fail(
            new TurnSteerKeyConflictError({
              clientSteerId: existing.clientSteerId ?? clientSteerId ?? "",
              message: "This steer key was already used for other words or another turn.",
            }),
          );
    if (clientSteerId !== null) {
      const existing = yield* conversations.steerByClientId(input.sender, clientSteerId);
      if (existing !== null) return yield* firstReceiptOrConflict(existing);
    }
    yield* host.requireLive(turn, "hosted");
    const entry = host.hosted(turn.processId);
    const attempt = Effect.gen(function* () {
      const admitted = yield* conversations.admitTurnSteer({
        turnId: turn.id,
        author: input.sender,
        input: input.input,
        clientSteerId,
      });
      if (!admitted.created) return yield* firstReceiptOrConflict(admitted.steer);
      return yield* deliverNewSteer(admitted.steer, entry);
    });
    const fiber = yield* Effect.forkIn(
      entry === undefined ? attempt : entry.steerPermit.withPermit(attempt),
      host.scope,
    );
    return yield* Fiber.join(fiber);
  });

  return { steerTurn, steerMessage };
};
