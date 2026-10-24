import { Effect, Semaphore } from "effect";

import { claudeTurnId, type ClaudeTurnInput, type ClaudeTurnState } from "./claude-turn.ts";
import type { ClaudeControlRequest, ClaudeUserMessage } from "./claude-wire.ts";
import {
  AgentSteerDeliveryError,
  AgentSteerRefusedError,
  type AgentControlCheckpoint,
  type AgentControlJournal,
  type AgentProtocolError,
  type AgentSteerAcceptance,
  type AgentSteerInput,
} from "./types.ts";

/**
 * Claude's steers and Stops, placed in its output. Each control is journaled with the number of
 * output lines reduced before it, and a rehydrate folds the recorded ones after the same lines,
 * so a replayed turn folds as the live one did whatever the chunking. A lane orders a control's
 * record, fold and write against line reduction.
 */

export interface ClaudeControlsContext {
  readonly journal: AgentControlJournal | undefined;
  readonly turn: () => ClaudeTurnState;
  readonly fold: (input: ClaudeTurnInput) => Effect.Effect<void>;
  readonly send: (
    frame: ClaudeUserMessage | ClaudeControlRequest,
  ) => Effect.Effect<void, AgentProtocolError>;
  readonly steerFrame: (input: AgentSteerInput) => ClaudeUserMessage;
  readonly closed: () => boolean;
}

export interface ClaudeControls {
  /** Fold the recorded controls due before any output line. */
  readonly replayDue: Effect.Effect<void>;
  /** Reduce one output line on the lane, then fold the recorded controls due after it. */
  readonly line: (reduce: Effect.Effect<void>) => Effect.Effect<void>;
  /** Run reduction that is not a line (the end of output) on the lane. */
  readonly exclusive: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly steer: (
    input: AgentSteerInput,
  ) => Effect.Effect<AgentSteerAcceptance, AgentSteerRefusedError | AgentSteerDeliveryError>;
  readonly interrupt: () => Effect.Effect<void, AgentProtocolError>;
}

const byPosition = (left: AgentControlCheckpoint, right: AgentControlCheckpoint): number =>
  left.afterOutputLine - right.afterOutputLine || left.ordinal - right.ordinal;

const undelivered = (
  certainty: AgentSteerDeliveryError["certainty"],
  message: string,
  cause: unknown,
) => new AgentSteerDeliveryError({ adapter: "claude", certainty, message, cause });

export const makeClaudeControls = Effect.fnUntraced(function* (context: ClaudeControlsContext) {
  const { journal, fold, send } = context;
  const recorded = (journal?.recorded ?? []).toSorted(byPosition);
  let cursor = 0;
  let nextOrdinal =
    recorded.reduce((highest, control) => Math.max(highest, control.ordinal), -1) + 1;
  let outputLines = 0;
  const lane = yield* Semaphore.make(1);

  const replayDue: Effect.Effect<void> = Effect.suspend(() => {
    const due: Array<AgentControlCheckpoint> = [];
    for (
      let control = recorded[cursor];
      control !== undefined && control.afterOutputLine <= outputLines;
      control = recorded[cursor]
    ) {
      due.push(control);
      cursor += 1;
    }
    return Effect.forEach(due, (control) => fold({ _tag: "Control", control }), {
      discard: true,
    });
  });

  // The lane is taken per line, not per chunk: a control waits for at most one line's
  // projection, and positions count lines either way. The yield lets a waiting control in
  // before the next line takes the lane back.
  const line = (reduce: Effect.Effect<void>): Effect.Effect<void> =>
    lane
      .withPermits(1)(
        reduce.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              outputLines += 1;
              return replayDue;
            }),
          ),
        ),
      )
      .pipe(Effect.andThen(journal === undefined ? Effect.void : Effect.yieldNow));

  /** Journal a control before it changes the turn or reaches the wire. */
  const record = (
    controlId: string,
    providerTurnId: string,
    action: AgentControlCheckpoint["action"],
  ): Effect.Effect<AgentControlCheckpoint, AgentProtocolError> =>
    Effect.suspend(() => {
      const control: AgentControlCheckpoint = {
        ordinal: nextOrdinal,
        controlId,
        providerTurnId,
        afterOutputLine: outputLines,
        action,
      };
      nextOrdinal += 1;
      return journal === undefined
        ? Effect.succeed(control)
        : journal.record(control).pipe(Effect.as(control));
    });

  const interruptNow = Effect.gen(function* () {
    const currentTurnId = claudeTurnId(context.turn());
    if (currentTurnId === null) return;
    const request: ClaudeControlRequest = {
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "interrupt" },
    };
    const control = yield* record(request.request_id, currentTurnId, "interrupt");
    // Written before the fold: a Stop can complete the turn, and whatever that completion
    // dispatches next must reach Claude after the interrupt, which names no turn. The fold
    // happens even when the write fails, as a rehydrate folds the journaled interrupt.
    const written = yield* Effect.exit(send(request));
    yield* fold({ _tag: "Control", control });
    return yield* written;
  });

  // Only a journaled interrupt needs the lane: its record is asynchronous, and the line it
  // names must be the line the fold happened after. Without a journal nothing is replayed,
  // and a Stop never waits behind a line's projection.
  const interrupt = Effect.fn("ClaudeAdapter.interrupt")(function* () {
    const stop = Effect.uninterruptible(interruptNow);
    yield* journal === undefined ? stop : lane.withPermits(1)(stop);
  });

  const refused = (
    input: AgentSteerInput,
    reason: AgentSteerRefusedError["reason"],
    message: string,
  ) =>
    new AgentSteerRefusedError({
      adapter: "claude",
      reason,
      expectedTurnId: input.expectedTurnId,
      actualTurnId: claudeTurnId(context.turn()),
      message,
    });

  /**
   * A `priority: "now"` user frame into the logical turn. Claude acknowledges nothing, so the
   * arm is journaled first: the result Claude prints when it aborts the running segment for
   * these words must not end the turn, live or replayed.
   */
  const steer = Effect.fn("ClaudeAdapter.steer")(function* (input: AgentSteerInput) {
    if (journal === undefined) {
      return yield* refused(
        input,
        "unsupported",
        "Claude is steered only with a control journal to replay it from.",
      );
    }
    // A journaled control is folded and written, or rolled back, before the lane is released,
    // whatever happens to its caller: otherwise a rehydrate folds a control live never did.
    return yield* lane.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const turn = context.turn();
          if (turn._tag === "Idle" || turn._tag === "Draining") {
            return yield* refused(input, "no-active-turn", "Claude has no running turn.");
          }
          if (turn.turnId !== input.expectedTurnId) {
            return yield* refused(input, "target-changed", "Claude is running another turn.");
          }
          if (turn._tag === "Stopping") {
            return yield* refused(input, "no-active-turn", "Claude's turn is being stopped.");
          }
          if (turn._tag !== "Running") {
            return yield* refused(
              input,
              "in-continuation",
              "Claude has not yet continued after the last steer.",
            );
          }
          if (context.closed()) {
            return yield* undelivered("not-written", "The Claude session is closed.", null);
          }
          const armed = yield* record(input.id, turn.turnId, "steer-now").pipe(
            Effect.mapError((error) => undelivered("not-written", error.message, error)),
          );
          yield* fold({ _tag: "Control", control: armed });
          // Closed while the journal was writing: nothing is sent, and the journal says so, so
          // a rehydrate disarms at the same line.
          if (context.closed()) {
            const disarmed = yield* record(input.id, turn.turnId, "not-written").pipe(
              Effect.option,
            );
            if (disarmed._tag === "Some") {
              yield* fold({ _tag: "Control", control: disarmed.value });
            }
            return yield* undelivered("not-written", "The Claude session is closed.", null);
          }
          yield* send(context.steerFrame(input)).pipe(
            Effect.mapError((error) => undelivered("uncertain", error.message, error)),
          );
          const acceptance: AgentSteerAcceptance = {
            _tag: "TransportWritten",
            providerTurnId: turn.turnId,
          };
          return acceptance;
        }),
      ),
    );
  });

  return {
    replayDue,
    line,
    exclusive: lane.withPermits(1),
    steer,
    interrupt,
  } satisfies ClaudeControls;
});
