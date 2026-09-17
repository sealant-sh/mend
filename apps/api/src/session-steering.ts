import { CurrentUser, NotFound, SessionNotSteerable } from "@mend/api-contracts";
import { AgentConversationRepo, ServicesRepo, SessionProcessesRepo } from "@mend/db";
import {
  type AgentRequestId,
  type AgentTurnId,
  type ServiceId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  canSteerSession,
  type AgentRequest,
  type AgentTurn,
  type Service,
  type Session,
  type SessionProcess,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";

type SteeringError = NotFound | SessionNotSteerable;

const refuse = (session: Session) =>
  new SessionNotSteerable({
    sessionId: session.id,
    message: "only the session owner can steer this session; the owner can turn on shared control",
  });

/**
 * Resolves whether the caller may steer a session, before any steering effect
 * (docs/adr/0003-organizations-and-tenancy.md, "Sessions and shared control").
 *
 * Visibility comes first: a session whose project the caller cannot see answers `NotFound` for
 * the id the caller supplied, exactly like a missing one. Only a visible session can answer
 * `SessionNotSteerable`, which names its session; that disclosure is harmless once the caller
 * can see the session anyway.
 */
export class SessionSteering extends Context.Service<
  SessionSteering,
  {
    /** For routes that authenticated outside the HTTP API: visibility, then ownership. */
    readonly authorizeUser: (
      session: Session,
      userId: string,
    ) => Effect.Effect<Session, SteeringError>;
    readonly session: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
    /** Stopping is steering, and an organization owner may also stop any session they can see. */
    readonly stop: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
    readonly process: (
      id: SessionProcessId,
    ) => Effect.Effect<
      { readonly process: SessionProcess; readonly session: Session },
      SteeringError,
      CurrentUser
    >;
    readonly service: (
      id: ServiceId,
    ) => Effect.Effect<
      { readonly service: Service; readonly session: Session },
      SteeringError,
      CurrentUser
    >;
    readonly turn: (
      id: AgentTurnId,
    ) => Effect.Effect<
      { readonly turn: AgentTurn; readonly session: Session },
      SteeringError,
      CurrentUser
    >;
    readonly agentRequest: (
      id: AgentRequestId,
    ) => Effect.Effect<
      { readonly request: AgentRequest; readonly session: Session },
      SteeringError,
      CurrentUser
    >;
  }
>()("@mend/api/SessionSteering") {}

export const SessionSteeringLive: Layer.Layer<
  SessionSteering,
  never,
  AgentConversationRepo | ProjectAccess | ServicesRepo | SessionProcessesRepo
> = Layer.effect(
  SessionSteering,
  Effect.gen(function* () {
    const conversation = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const access = yield* ProjectAccess;

    const authorizeUser = Effect.fn("SessionSteering.authorizeUser")(function* (
      session: Session,
      userId: string,
    ) {
      yield* access
        .projectAs(userId, session.projectId)
        .pipe(Effect.mapError(() => new NotFound({ id: session.id })));
      if (!canSteerSession(session, userId)) return yield* refuse(session);
      return session;
    });

    const session = Effect.fn("SessionSteering.session")(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const row = yield* access.session(id);
      if (!canSteerSession(row, caller.user.id)) return yield* refuse(row);
      return row;
    });

    const stop = Effect.fn("SessionSteering.stop")(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const row = yield* access.session(id);
      if (canSteerSession(row, caller.user.id)) return row;
      const viewer = yield* access.viewer();
      if (viewer !== null && viewer.role === "owner") return row;
      return yield* refuse(row);
    });

    /** A child row's session, with a hidden parent answering `NotFound` for the child's id. */
    const through = (childId: string, sessionId: SessionId) =>
      session(sessionId).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(new NotFound({ id: childId }))),
      );

    const process = Effect.fn("SessionSteering.process")(function* (id: SessionProcessId) {
      const row = yield* processes.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { process: row, session: yield* through(id, row.sessionId) };
    });

    const service = Effect.fn("SessionSteering.service")(function* (id: ServiceId) {
      const row = yield* services.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { service: row, session: yield* through(id, row.sessionId) };
    });

    const turn = Effect.fn("SessionSteering.turn")(function* (id: AgentTurnId) {
      const row = yield* conversation.byTurnId(id);
      if (row === null) return yield* new NotFound({ id });
      return { turn: row, session: yield* through(id, row.sessionId) };
    });

    const agentRequest = Effect.fn("SessionSteering.agentRequest")(function* (id: AgentRequestId) {
      const row = yield* conversation.byRequestId(id);
      if (row === null) return yield* new NotFound({ id });
      return { request: row, session: yield* through(id, row.sessionId) };
    });

    return { authorizeUser, session, stop, process, service, turn, agentRequest };
  }),
);
