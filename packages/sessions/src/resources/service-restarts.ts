import { ServicesRepo, SessionProcessesRepo, SessionsRepo } from "@mend/db";
import type { SessionId, SessionProcessId, WorktreeId } from "@mend/domain";
import {
  LIVE_PROCESS_STATUSES,
  isAgentProcessKind,
  MessageInput,
  type ResourceServiceRestart,
} from "@mend/domain/workbench";
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
    readonly restart: (
      worktreeId: WorktreeId,
      by: string,
    ) => Effect.Effect<ReadonlyArray<ResourceServiceRestart>>;
    /** Send a switch to other live agent sessions as the switching person. */
    readonly tell: (
      worktreeId: WorktreeId,
      by: string,
      message: string,
      except: SessionId | null,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@mend/sessions/WorktreeServiceRestarts") {}

/** Restarts nothing: for a composition with no engine. */
export const WorktreeServiceRestartsNone: Layer.Layer<WorktreeServiceRestarts> = Layer.succeed(
  WorktreeServiceRestarts,
  { restart: () => Effect.succeed([]), tell: () => Effect.succeed([]) },
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
      const restarted: Array<ResourceServiceRestart> = [];
      for (const session of yield* sessions.listForWorktree(worktreeId)) {
        for (const service of yield* services.listForSession(session.id)) {
          if (!(yield* running(service.currentAttemptId))) continue;
          const outcome = yield* engine
            .restartService(service.id, { kind: "person", userId: by })
            .pipe(Effect.result);
          if (outcome._tag === "Success") restarted.push({ name: service.name, kind: "restarted" });
          else {
            restarted.push({
              name: service.name,
              kind: "failed",
              message: outcome.failure.message,
            });
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

    const tell = Effect.fn("WorktreeServiceRestarts.tell")(function* (
      worktreeId: WorktreeId,
      by: string,
      message: string,
      except: SessionId | null,
    ) {
      const failed: string[] = [];
      for (const session of yield* sessions.listForWorktree(worktreeId)) {
        if (
          session.id === except ||
          !["starting", "running", "waiting", "idle"].includes(session.status)
        )
          continue;
        const agents = yield* processes.listForSession(session.id);
        if (
          !agents.some(
            (process) =>
              isAgentProcessKind(process.kind) &&
              process.exitedAt === null &&
              LIVE_PROCESS_STATUSES.has(process.status),
          )
        )
          continue;
        const answer = yield* engine
          .sendMessage({
            sessionId: session.id,
            sender: by,
            input: MessageInput.make(message),
            clientMessageId: null,
            intent: "default",
          })
          .pipe(Effect.result);
        if (answer._tag === "Failure")
          failed.push(
            `could not tell the agent in ${session.label ?? session.id}: ${answer.failure.message}`,
          );
      }
      return failed;
    });
    return { restart, tell };
  }),
);
