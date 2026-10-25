import type { AgentSession } from "@mend/agent-protocol";
import { type AgentConversationRepo, AgentTurnNotFoundError } from "@mend/db";
import type { AgentTurnId, SessionProcessId } from "@mend/domain";
import {
  turnSteerSender,
  type AgentTurn,
  type AgentTurnSteer,
  type SessionProcess,
  type TurnSteerQueueReason,
} from "@mend/domain/workbench";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, type Scope } from "effect";
import type * as Semaphore from "effect/Semaphore";

export class TurnSteerForbiddenError extends Schema.TaggedError<TurnSteerForbiddenError>()(
  "TurnSteerForbiddenError",
  {
    turnId: Schema.String,
    reason: Schema.Literals(["not-sender", "no-sender"]),
    message: Schema.String,
  },
) {}

export class InvalidTurnSteerError extends Schema.TaggedError<InvalidTurnSteerError>()(
  "InvalidTurnSteerError",
  { message: Schema.String },
) {}

/** A retry's key already names a steer of another turn, or of other words. */
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

/** How long a steer waits for a rehydrated process's replay before its words become a turn. */
const STEER_READY_WAIT = "5 seconds";

/** What a steer reads and reserves on a process the host holds. */
export interface SteerableProcess {
  readonly process: SessionProcess;
  readonly adapter: AgentSession;
  readonly steerPermit: Semaphore.Semaphore;
  /** Non-null on rehydrate: opens once replay is projected up to its high water; steers wait. */
  readonly steerGate: Deferred.Deferred<void> | null;
  readonly stopping: boolean;
  readonly handingOverTo: string | null;
  /** Steers holding the process: dispatch and a hand-over's stop wait while any does. */
  controls: number;
}

export interface TurnSteeringHost<P extends SteerableProcess, E> {
  readonly conversations: AgentConversationRepo["Service"];
  readonly hosted: (processId: SessionProcessId) => P | undefined;
  /** Fails when no live process of the turn's session is hosted here. */
  readonly requireLive: (turn: AgentTurn) => Effect.Effect<void, E>;
  /** The words become the sender's next queued turn, or NotSent when none can take them. */
  readonly carry: (
    steer: AgentTurnSteer,
    reason: TurnSteerQueueReason,
  ) => Effect.Effect<AgentTurnSteer>;
  /** A steer gave its process back. */
  readonly released: (entry: P) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}

type SteerTarget<P> =
  | { readonly _tag: "Carry"; readonly reason: TurnSteerQueueReason }
  | { readonly _tag: "Running"; readonly turn: AgentTurn; readonly entry: P };

/** Opens a rehydrated process's steer gate once its replay is projected up to its high water. */
export const openSteerGate = (
  gate: Deferred.Deferred<void>,
  projected: () => boolean,
  stillHosted: () => boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // A steer acts on the adapter's state, so it waits for the last recorded line to be
    // projected, not for its bytes; a partial final record holds steers only, never dispatch.
    while (stillHosted() && !projected()) {
      yield* Effect.sleep("100 millis");
    }
    yield* Deferred.succeed(gate, undefined);
  });

/** Native mid-turn steering of a hosted turn by its sender (docs/adr/0013, docs/adr/0016). */
export const makeTurnSteering = <P extends SteerableProcess, E>(host: TurnSteeringHost<P, E>) => {
  const { conversations } = host;

  /** The running turn a steer can reach on `entry`, or why its words become the next turn. */
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
        // A hand-over waits for this process to go quiet; a steer would keep it busy.
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
    if (target._tag === "Carry") return yield* host.carry(steer, target.reason);
    const providerTurnId = target.turn.providerTurnId;
    if (providerTurnId === null) return yield* host.carry(steer, "not-acknowledged");
    if (!entry.adapter.activeSteering.supported) return yield* host.carry(steer, "unsupported");
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
    if (error._tag === "AgentSteerRefusedError") return yield* host.carry(steer, error.reason);
    if (error.certainty === "not-written") return yield* host.carry(steer, "not-written");
    return yield* conversations.settleTurnSteer(steer.id, {
      _tag: "Unknown",
      reason: "uncertain",
    });
  });

  const deliverSteer = Effect.fn("ProtocolHost.deliverSteer")(function* (
    steer: AgentTurnSteer,
    entry: P | undefined,
  ) {
    // An ended or queued target needs nothing from the adapter: its words are carried at once.
    let target = yield* steerTarget(steer, entry);
    if (target._tag === "Carry") return yield* host.carry(steer, target.reason);
    const gate = target.entry.steerGate;
    if (gate !== null) {
      // Replay must be projected before the adapter's state is the harness's present. Nothing
      // is reserved while it waits, so dispatch goes on behind a record that never completes.
      const ready = yield* Deferred.await(gate).pipe(Effect.timeoutOption(STEER_READY_WAIT));
      if (Option.isNone(ready)) return yield* host.carry(steer, "replaying");
      target = yield* steerTarget(steer, entry);
      if (target._tag === "Carry") return yield* host.carry(steer, target.reason);
    }
    const running = target.entry;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        running.controls += 1;
      }),
      () => sendSteer(steer, running),
      () =>
        Effect.suspend(() => {
          running.controls -= 1;
          return host.released(running);
        }),
    );
  });

  const steerTurn = Effect.fn("ProtocolHost.steerTurn")(function* (input: SteerTurnInput) {
    if (input.input.trim().length === 0)
      return yield* new InvalidTurnSteerError({ message: "A steer must contain words." });
    const turn = yield* conversations.byTurnId(input.turnId);
    if (turn === null) return yield* new AgentTurnNotFoundError({ turnId: input.turnId });
    const sender = turnSteerSender(turn);
    if (sender === null || sender !== input.sender)
      return yield* new TurnSteerForbiddenError({
        turnId: turn.id,
        reason: sender === null ? "no-sender" : "not-sender",
        message:
          sender === null ? "This turn has no recorded sender." : "Only this turn's sender may steer it.",
      });
    const clientSteerId = input.clientSteerId?.toLowerCase() ?? null;
    /** A retry gets its first receipt; the same key for another turn or other words is refused. */
    const retried = (existing: AgentTurnSteer) =>
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
      if (existing !== null) return yield* retried(existing);
    }
    yield* host.requireLive(turn);
    const entry = host.hosted(turn.processId);
    // Admission and delivery share a host-owned lane, so ordinals also order wire attempts.
    // HTTP cancellation stops only the join; Stop and output projection never take this lane.
    const attempt = Effect.gen(function* () {
      const admitted = yield* conversations.admitTurnSteer({
        turnId: turn.id,
        author: input.sender,
        input: input.input,
        clientSteerId,
      });
      if (!admitted.created) return yield* retried(admitted.steer);
      // A delivery that fails or dies may have written its words: never left Sending on a live
      // server. An interrupt is a shutdown, which the next start's recovery settles.
      return yield* deliverSteer(admitted.steer, entry).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? conversations
                .settleTurnSteer(admitted.steer.id, { _tag: "Unknown", reason: "failed" })
                .pipe(Effect.exit, Effect.asVoid)
            : Effect.void,
        ),
      );
    });
    const fiber = yield* Effect.forkIn(
      entry === undefined ? attempt : entry.steerPermit.withPermit(attempt),
      host.scope,
    );
    return yield* Fiber.join(fiber);
  });

  return { steerTurn };
};
