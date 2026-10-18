import { IssuesRepo, SettingsRepo } from "@mend/db";
import type { ChangeId, Issue, RunId } from "@mend/domain";
import { Config, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import * as Context from "effect/Context";

/** A routed run could not start — the message is written for the review thread. */
export class RunStartError extends Schema.TaggedError<RunStartError>()("RunStartError", {
  message: Schema.String,
}) {}

/**
 * Starts harness runs: the dispatcher hands it the top of the queue (initial
 * runs), and comment routing hands it review actions (follow-up and
 * verification runs on a change's existing branch and workspace).
 */
export class RunStarter extends Context.Service<
  RunStarter,
  {
    readonly start: (issue: Issue) => Effect.Effect<void>;
    /** The `start_run` tool's engine — runs on the change's existing workspace. */
    readonly startOnChange: (
      change: ChangeId,
      instruction: string,
      kind: "follow-up" | "verification",
    ) => Effect.Effect<RunId, RunStartError>;
  }
>()("@mend/jobs/RunStarter") {}

/** What one dispatch pass observed and did — returned so tests can assert it. */
export interface DispatchTick {
  readonly concurrency: number;
  readonly mending: number;
  readonly started: boolean;
}

/**
 * The user-visible queue is domain state (`issues.position`), never a job
 * queue. This single loop fills free mending slots from the top of `queued`.
 * Gate 1 stays human: nothing lands in `queued` unless a person dragged it.
 */
export class Dispatcher extends Context.Service<
  Dispatcher,
  {
    readonly tick: () => Effect.Effect<DispatchTick>;
    /** Poll-driven for now; LISTEN/NOTIFY wake-ups arrive with M1. */
    readonly run: () => Effect.Effect<void>;
  }
>()("@mend/jobs/Dispatcher") {
  static readonly layer = Layer.effect(
    Dispatcher,
    Effect.gen(function* () {
      const issues = yield* IssuesRepo;
      const settings = yield* SettingsRepo;
      const starter = yield* RunStarter;
      const interval = yield* Config.Duration("MEND_DISPATCH_INTERVAL").pipe(
        Config.orElse(() => Config.succeed(Duration.seconds(5))),
      );

      const tick = Effect.fn("Dispatcher.tick")(function* () {
        const current = yield* settings.get();
        const mending = yield* issues.countByStage("mending");
        const free = current.concurrency - mending;
        if (free <= 0) return { concurrency: current.concurrency, mending, started: false };

        const top = yield* issues.topOfQueued();
        if (Option.isNone(top)) {
          return { concurrency: current.concurrency, mending, started: false };
        }

        yield* starter.start(top.value);
        return { concurrency: current.concurrency, mending, started: true };
      });

      const run = Effect.fn("Dispatcher.run")(function* () {
        yield* Effect.logInfo("dispatcher: polling").pipe(
          Effect.annotateLogs({ interval: Duration.format(interval) }),
        );
        yield* tick().pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("dispatcher: tick died").pipe(Effect.annotateLogs({ defect })),
          ),
          Effect.repeat(Schedule.spaced(interval)),
        );
      });

      return { tick, run };
    }),
  );
}
