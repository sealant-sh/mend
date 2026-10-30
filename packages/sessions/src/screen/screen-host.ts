import { AgentConversationRepo, SessionProcessesRepo, SessionsRepo } from "@mend/db";
import type { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import type { Screen } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { SessionEngine } from "../engine.ts";
import type { ScreenPasswords } from "./passwords.ts";

export class ScreenStartError extends Schema.TaggedError<ScreenStartError>()("ScreenStartError", {
  message: Schema.String,
}) {}

/** What `Screens` needs of a session: its owner, its screen's start, and that screen's process. */
export class ScreenHost extends Context.Service<
  ScreenHost,
  {
    readonly ownerOf: (sessionId: SessionId) => Effect.Effect<string | null>;
    /** Starts the session's screen, or answers the one this process started and still holds. */
    readonly start: (sessionId: SessionId) => Effect.Effect<Screen, ScreenStartError>;
    readonly passwords: (sessionId: SessionId) => Effect.Effect<ScreenPasswords | null>;
    /** The Sealant PTY session a live screen process leads, which a forward to it is bound to. */
    readonly ptyOf: (processId: SessionProcessId) => Effect.Effect<string | null>;
    /** The turn the agent process is running; null for one that runs no turns. */
    readonly turnOf: (
      sessionId: SessionId,
      processId: SessionProcessId,
    ) => Effect.Effect<AgentTurnId | null>;
  }
>()("@mend/sessions/ScreenHost") {}

export const ScreenHostLive: Layer.Layer<
  ScreenHost,
  never,
  SessionEngine | SessionsRepo | SessionProcessesRepo | AgentConversationRepo
> = Layer.effect(
  ScreenHost,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const conversation = yield* AgentConversationRepo;
    return {
      ownerOf: (sessionId) =>
        sessions.byId(sessionId).pipe(
          Effect.map((session) => session.ownerUserId),
          Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)),
        ),
      start: (sessionId) =>
        engine
          .startScreen(sessionId)
          .pipe(
            Effect.mapError(
              (error) => new ScreenStartError({ message: error.message || error._tag }),
            ),
          ),
      passwords: engine.screenPasswords,
      ptyOf: (processId) =>
        Effect.map(processes.byId(processId), (row) =>
          row?.exitedAt === null ? row.sealantSessionId : null,
        ),
      turnOf: (sessionId, processId) =>
        Effect.map(
          conversation.openTurns(sessionId),
          (turns) =>
            turns.find((turn) => turn.processId === processId && turn.status === "running")?.id ??
            null,
        ),
    };
  }),
);
