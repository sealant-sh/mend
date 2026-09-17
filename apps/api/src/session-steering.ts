import { CurrentUser, NotFound, SessionNotSteerable } from "@mend/api-contracts";
import {
  AgentConversationRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  UserDotfilesRepo,
} from "@mend/db";
import {
  type AgentRequestId,
  type AgentTurnId,
  type ServiceId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import type {
  AgentRequest,
  AgentTurn,
  Service,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";

export interface CanSteerSessionInput {
  readonly ownerUserId: string | null;
  readonly callerUserId: string;
  readonly fallbackOwnerUserId: string | null;
}

/** Shared control and organization-owner authority will extend this one decision in later PRs. */
export const canSteerSession = (input: CanSteerSessionInput): boolean => {
  const effectiveOwner = input.ownerUserId ?? input.fallbackOwnerUserId;
  return effectiveOwner !== null && input.callerUserId === effectiveOwner;
};

type SteeringError = NotFound | SessionNotSteerable;

/**
 * Resolves session ownership before a caller performs a steering operation.
 *
 * `SessionNotSteerable` carries the parent session ID. When project visibility lands in ADR 0003
 * delivery step 3, callers must check visibility before steering so an inaccessible resource
 * answers 404 without disclosing its parent session through a 403 response.
 */
export class SessionSteering extends Context.Service<
  SessionSteering,
  {
    readonly authorizeUser: (
      session: Session,
      userId: string,
    ) => Effect.Effect<Session, SessionNotSteerable>;
    readonly session: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
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
  AgentConversationRepo | ServicesRepo | SessionProcessesRepo | SessionsRepo | UserDotfilesRepo
> = Layer.effect(
  SessionSteering,
  Effect.gen(function* () {
    const conversation = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const sessions = yield* SessionsRepo;
    const dotfiles = yield* UserDotfilesRepo;
    const firstUserIdRef = yield* Ref.make<string | null>(null);

    const firstUserId = Effect.fn("SessionSteering.firstUserId")(function* () {
      const cached = yield* Ref.get(firstUserIdRef);
      if (cached !== null) return cached;
      const found = yield* dotfiles.firstUserId();
      if (found !== null) yield* Ref.set(firstUserIdRef, found);
      return found;
    });

    const authorizeUser = Effect.fn("SessionSteering.authorizeUser")(function* (
      session: Session,
      userId: string,
    ) {
      const fallbackOwnerUserId = session.ownerUserId === null ? yield* firstUserId() : null;
      if (
        !canSteerSession({
          ownerUserId: session.ownerUserId,
          callerUserId: userId,
          fallbackOwnerUserId,
        })
      ) {
        return yield* new SessionNotSteerable({
          sessionId: session.id,
          message: "only the session owner can steer this session",
        });
      }
      return session;
    });

    const authorize = Effect.fn("SessionSteering.authorize")(function* (session: Session) {
      const caller = yield* CurrentUser;
      return yield* authorizeUser(session, caller.user.id);
    });

    const session = Effect.fn("SessionSteering.session")(function* (id: SessionId) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      return yield* authorize(row);
    });

    const process = Effect.fn("SessionSteering.process")(function* (id: SessionProcessId) {
      const row = yield* processes.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { process: row, session: yield* session(row.sessionId) };
    });

    const service = Effect.fn("SessionSteering.service")(function* (id: ServiceId) {
      const row = yield* services.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { service: row, session: yield* session(row.sessionId) };
    });

    const turn = Effect.fn("SessionSteering.turn")(function* (id: AgentTurnId) {
      const row = yield* conversation.byTurnId(id);
      if (row === null) return yield* new NotFound({ id });
      return { turn: row, session: yield* session(row.sessionId) };
    });

    const agentRequest = Effect.fn("SessionSteering.agentRequest")(function* (id: AgentRequestId) {
      const row = yield* conversation.byRequestId(id);
      if (row === null) return yield* new NotFound({ id });
      return { request: row, session: yield* session(row.sessionId) };
    });

    return { authorizeUser, session, process, service, turn, agentRequest };
  }),
);
