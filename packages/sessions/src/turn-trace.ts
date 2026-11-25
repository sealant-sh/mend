import { spanOfCarrier } from "@mend/telemetry";
import { Clock, Context, Effect, Exit, Option, Tracer } from "effect";

/**
 * A conversation turn's trace (SLNT-1349, "Crossing async boundaries"). A turn is accepted in one
 * request, waits in the queue, and runs on the agent long after that request answered; the context
 * it was accepted in is kept on its row (`trace_context`), and each later stage continues it, one
 * span per stage and never one per token:
 *
 * - `mend.turn.dispatch`: claiming the turn and writing it to the agent (`mend.turn.input`);
 * - `mend.turn.run`: from the agent taking the turn to its end;
 * - `mend.turn.first_output`: within the run, until the turn's first item came back.
 *
 * A turn that ends after a restart, with no run span of this process's, still ends its trace with
 * `mend.turn.complete`. Tracing never changes what a turn does: every step here only observes.
 */

/** What a stage names about its turn: IDs and enums only. */
export interface TracedTurn<Id extends string = string> {
  readonly id: Id;
  readonly sessionId: string;
}

interface Run {
  readonly span: Tracer.Span;
  firstOutput: boolean;
}

/** Runs this many turns at most are held open; the oldest is ended first past it. */
const MAX_OPEN_RUNS = 1_000;

export interface TurnTraces<Id extends string = string> {
  /** `effect` as the turn's dispatch: a span parented on the context it was accepted in. */
  readonly dispatch: <A, E, R>(
    turn: TracedTurn<Id>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The agent took the turn as `providerTurnId`: its run starts. Once per provider turn. */
  readonly begin: (turn: TracedTurn<Id>, providerTurnId: string) => Effect.Effect<void>;
  /** An item of the turn came back: the first one ends `mend.turn.first_output`. */
  readonly output: (providerTurnId: string | null | undefined) => Effect.Effect<void>;
  /** The turn ended with `status`. */
  readonly end: (
    turn: TracedTurn<Id> & { readonly status: string },
    providerTurnId: string,
  ) => Effect.Effect<void>;
}

const attributesOf = (turn: TracedTurn) => ({
  "mend.turn_id": turn.id,
  "mend.session_id": turn.sessionId,
});

const endRun = (run: Run, attributes: Record<string, string>) =>
  Effect.flatMap(Clock.currentTimeNanos, (now) =>
    Effect.sync(() => {
      for (const [key, value] of Object.entries(attributes)) run.span.attribute(key, value);
      run.span.end(now, Exit.void);
    }),
  );

/** Turn traces over `traceOf`, the stored context of a turn by its id. */
export const makeTurnTraces = <Id extends string>(
  traceOf: (turnId: Id) => Effect.Effect<unknown>,
): TurnTraces<Id> => {
  const runs = new Map<string, Run>();

  /** A span parented on the turn's stored context, or a trace of its own for a turn with none. */
  const parentOf = (turn: TracedTurn<Id>) =>
    Effect.map(traceOf(turn.id), (carrier) => {
      const parent = spanOfCarrier(carrier);
      return parent === undefined ? { root: true } : { parent };
    });

  const dispatch: TurnTraces<Id>["dispatch"] = (turn, effect) =>
    Effect.flatMap(parentOf(turn), (parent) =>
      effect.pipe(
        Effect.withSpan("mend.turn.dispatch", { ...parent, attributes: attributesOf(turn) }),
        Effect.withTracerEnabled(true),
      ),
    );

  const begin: TurnTraces<Id>["begin"] = (turn, providerTurnId) =>
    Effect.gen(function* () {
      if (runs.has(providerTurnId)) return;
      const parent = yield* parentOf(turn);
      const span = yield* Effect.makeSpan("mend.turn.run", {
        ...parent,
        attributes: attributesOf(turn),
      }).pipe(Effect.withTracerEnabled(true));
      runs.set(providerTurnId, { span, firstOutput: false });
      for (const [id, run] of runs) {
        if (runs.size <= MAX_OPEN_RUNS) break;
        runs.delete(id);
        yield* endRun(run, { "mend.turn.status": "unobserved" });
      }
    });

  const output: TurnTraces<Id>["output"] = (providerTurnId) =>
    Effect.gen(function* () {
      if (providerTurnId === null || providerTurnId === undefined) return;
      const run = runs.get(providerTurnId);
      if (run === undefined || run.firstOutput) return;
      run.firstOutput = true;
      const tracer = yield* Tracer.Tracer;
      const now = yield* Clock.currentTimeNanos;
      const started = run.span.status.startTime;
      // Its own start, the run's: how long the agent took to say anything.
      const span = tracer.span({
        name: "mend.turn.first_output",
        parent: Option.some(run.span),
        annotations: Context.empty(),
        links: [],
        startTime: started,
        kind: "internal",
        root: false,
        sampled: run.span.sampled,
      });
      span.end(now, Exit.void);
    });

  const end: TurnTraces<Id>["end"] = (turn, providerTurnId) =>
    Effect.gen(function* () {
      const run = runs.get(providerTurnId);
      if (run !== undefined) {
        runs.delete(providerTurnId);
        return yield* endRun(run, { "mend.turn.status": turn.status });
      }
      // Ended after a restart, or by a run this process never began: its trace still ends.
      const parent = yield* parentOf(turn);
      yield* Effect.annotateCurrentSpan("mend.turn.status", turn.status).pipe(
        Effect.withSpan("mend.turn.complete", { ...parent, attributes: attributesOf(turn) }),
        Effect.withTracerEnabled(true),
      );
    });

  return { dispatch, begin, output, end };
};
