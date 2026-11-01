import {
  AgentConversationRepo,
  HarnessLayoutsRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import type { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import type { ProofRegion, Screen } from "@mend/domain/workbench";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect, Layer, Schema, type Scope } from "effect";
import * as Context from "effect/Context";

import { SessionEngine } from "../engine.ts";
import { processUserOf } from "../harness-layout.ts";
import type { ScreenPasswords } from "./passwords.ts";
import { screenRegionArgv, screenStartOfArgv } from "./script.ts";

export class ScreenStartError extends Schema.TaggedError<ScreenStartError>()("ScreenStartError", {
  message: Schema.String,
}) {}

/** What `Screens` needs of a session: its owner, its screen's start, and that screen's process. */
export class ScreenHost extends Context.Service<
  ScreenHost,
  {
    /** A dedicated region encoder, closed when the recording's scope ends. */
    readonly regionEncoder: (
      screen: Screen,
      region: ProofRegion,
    ) => Effect.Effect<
      { readonly pty: string; readonly port: number },
      ScreenStartError,
      Scope.Scope
    >;
    readonly ownerOf: (sessionId: SessionId) => Effect.Effect<string | null>;
    /** Starts the session's screen, or answers the one this process started and still holds. */
    readonly start: (sessionId: SessionId) => Effect.Effect<Screen, ScreenStartError>;
    readonly passwords: (sessionId: SessionId) => Effect.Effect<ScreenPasswords | null>;
    /** A live screen an earlier process started, signed for again; false when it could not be. */
    readonly rekey: (sessionId: SessionId) => Effect.Effect<boolean>;
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
  | SessionEngine
  | SessionsRepo
  | SessionProcessesRepo
  | AgentConversationRepo
  | HarnessLayoutsRepo
  | SealantClient
> = Layer.effect(
  ScreenHost,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const conversation = yield* AgentConversationRepo;
    const identities = yield* HarnessLayoutsRepo;
    const sealant = yield* SealantClient;
    return {
      regionEncoder: (screen, region) =>
        Effect.gen(function* () {
          const row = screen.processId === null ? null : yield* processes.byId(screen.processId);
          const start = row === null ? null : screenStartOfArgv(row.argv);
          if (row === null || row.exitedAt !== null || row.runsAs === null || start === null)
            return yield* new ScreenStartError({ message: "screen process unavailable" });
          const owner = row.runsAs;
          const [person] = yield* identities.identitiesOf([owner]);
          if (person === undefined)
            return yield* new ScreenStartError({ message: "screen person unavailable" });
          return yield* Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(row.sealantWorkspaceId);
            const pty = yield* Effect.acquireRelease(
              sealant.openSession(workspace, screenRegionArgv(screen.display, start.dir, region), {
                user: processUserOf(person),
              }),
              (session) =>
                Effect.tryPromise(() => session.close()).pipe(
                  Effect.timeoutOption("5 seconds"),
                  Effect.catch(() => Effect.logWarning("proof region encoder close unavailable")),
                ),
            );
            return { pty: pty.id, port: 8300 + screen.display };
          }).pipe(asSealantUser(owner));
        }).pipe(
          Effect.mapError(() => new ScreenStartError({ message: "region encoder unavailable" })),
        ),
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
      rekey: engine.rekeyScreen,
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
