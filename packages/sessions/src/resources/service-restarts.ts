import { ServicesRepo, SessionProcessesRepo, SessionsRepo } from "@mend/db";
import type { SessionProcessId, WorktreeId } from "@mend/domain";
import { LIVE_PROCESS_STATUSES } from "@mend/domain/workbench";
import { Cause, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { SessionEngine } from "../engine.ts";

/**
 * Restarts the Services running in a worktree, so they open again with its resources' current env
 * (ADR 0019, story 3: a switch restarts the worktree's Services). `Resources` asks it, and never
 * the engine itself.
 */
export class WorktreeServiceRestarts extends Context.Service<
  WorktreeServiceRestarts,
  {
    /** Restarts each running Service of every session in the worktree as `by`; answers their names. */
    readonly restart: (worktreeId: WorktreeId, by: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@mend/sessions/WorktreeServiceRestarts") {}

/** Restarts nothing: for a composition with no engine. */
export const WorktreeServiceRestartsNone: Layer.Layer<WorktreeServiceRestarts> = Layer.succeed(
  WorktreeServiceRestarts,
  { restart: () => Effect.succeed([]) },
);

export const WorktreeServiceRestartsLive: Layer.Layer<
  WorktreeServiceRestarts,
  never,
  SessionEngine | SessionsRepo | ServicesRepo | SessionProcessesRepo
> = Layer.effect(
  WorktreeServiceRestarts,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const services = yield* ServicesRepo;
    const processes = yield* SessionProcessesRepo;

    /** Whether the Service's current attempt is a live process. */
    const running = (attemptId: SessionProcessId | null) =>
      attemptId === null
        ? Effect.succeed(false)
        : processes
            .byId(attemptId)
            .pipe(
              Effect.map(
                (attempt) =>
                  attempt !== null &&
                  attempt.exitedAt === null &&
                  LIVE_PROCESS_STATUSES.has(attempt.status),
              ),
            );

    const restart = Effect.fn("WorktreeServiceRestarts.restart")(function* (
      worktreeId: WorktreeId,
      by: string,
    ) {
      const restarted: Array<string> = [];
      for (const session of yield* sessions.listForWorktree(worktreeId)) {
        for (const service of yield* services.listForSession(session.id)) {
          if (!(yield* running(service.currentAttemptId))) continue;
          const outcome = yield* engine
            .restartService(service.id, { kind: "person", userId: by })
            .pipe(Effect.result);
          if (outcome._tag === "Success") restarted.push(service.name);
          else {
            yield* Effect.logWarning("resources: a Service did not restart after a switch").pipe(
              Effect.annotateLogs({
                serviceId: service.id,
                cause: Cause.pretty(Cause.fail(outcome.failure)),
              }),
            );
          }
        }
      }
      return restarted;
    });

    return { restart };
  }),
);
