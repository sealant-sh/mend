import {
  CurrentUser,
  NotFound,
  SessionControlView,
  SessionNotSteerable,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  OrganizationsRepo,
  ProjectsRepo,
  ServicesRepo,
  SessionProcessesRepo,
} from "@mend/db";
import {
  type AgentRequestId,
  type AgentTurnId,
  type ServiceId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  canSteerSession,
  canToggleSharedControl,
  canTypeInTerminal,
  type AgentRequest,
  type AgentTurn,
  type Service,
  type Session,
  type SessionProcess,
  type SteeringFacts,
  type Viewer,
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
 * What the viewer may do with a session, as its detail tells clients, so they show only real
 * controls (docs/adr/0003). Typing in its terminals is the owner's alone (docs/adr/0013).
 */
export const sessionControlView = (
  session: SteeringFacts,
  viewer: Pick<Viewer, "userId" | "role"> | null,
): SessionControlView => {
  const steer = viewer !== null && canSteerSession(session, viewer.userId);
  return new SessionControlView({
    own: viewer !== null && session.ownerUserId === viewer.userId,
    steer,
    stop: steer || viewer?.role === "owner",
    toggleSharedControl:
      viewer !== null &&
      canToggleSharedControl(session, viewer, session.sharedControlEnabledAt === null),
    terminalInput: viewer !== null && canTypeInTerminal(session, viewer.userId),
  });
};

/** What only the owner runs in a session's workspace, and the words its refusal says. */
const OWNER_RUNS = {
  terminal:
    "only the session owner starts its agent in a terminal, even while control is shared; the owner can continue it as a conversation",
  command: "only the session owner runs commands in its workspace, even while control is shared",
} as const;

/**
 * Anything that runs in a session's workspace besides a turn spends whatever login the workspace
 * holds, so it is the owner's alone, even while control is shared (docs/adr/0013): a terminal
 * agent started with the caller's words, which is typing into it, and a command such as a
 * Service. Call it after `SessionSteering.session`, so a caller who cannot steer at all hears that.
 */
export const requireOwnerRuns = Effect.fn("SessionSteering.requireOwnerRuns")(function* (
  session: Session,
  act: keyof typeof OWNER_RUNS,
) {
  const caller = yield* CurrentUser;
  if (canTypeInTerminal(session, caller.user.id)) return session;
  return yield* new SessionNotSteerable({ sessionId: session.id, message: OWNER_RUNS[act] });
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
    /** Owners who remain members may watch their terminal after project visibility changes. */
    readonly authorizeTerminal: (
      session: Session,
      userId: string,
    ) => Effect.Effect<Session, SteeringError>;
    readonly session: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
    /**
     * The owner's own acts, closed to others even while control is shared: deleting the session,
     * renaming it, handing it off. Shared control lends steering, not the session itself.
     */
    readonly owned: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
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
  | AgentConversationRepo
  | OrganizationsRepo
  | ProjectsRepo
  | ProjectAccess
  | ServicesRepo
  | SessionProcessesRepo
> = Layer.effect(
  SessionSteering,
  Effect.gen(function* () {
    const conversation = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const access = yield* ProjectAccess;
    const organizations = yield* OrganizationsRepo;
    const projects = yield* ProjectsRepo;

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

    const authorizeTerminal = Effect.fn("SessionSteering.authorizeTerminal")(function* (
      session: Session,
      userId: string,
    ) {
      if (session.ownerUserId !== userId) return yield* authorizeUser(session, userId);
      const project = yield* projects
        .byId(session.projectId)
        .pipe(Effect.mapError(() => new NotFound({ id: session.id })));
      const membership = yield* organizations.membershipOf(userId);
      if (membership?.organization.id !== project.organizationId) {
        return yield* new NotFound({ id: session.id });
      }
      // Watching does not lend input. The terminal route separately checks WorkspaceCaller.mayAct.
      return session;
    });

    const session = Effect.fn("SessionSteering.session")(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const row = yield* access.session(id);
      if (!canSteerSession(row, caller.user.id)) return yield* refuse(row);
      return row;
    });

    const owned = Effect.fn("SessionSteering.owned")(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const row = yield* access.session(id);
      if (row.ownerUserId === null || row.ownerUserId !== caller.user.id) {
        return yield* new SessionNotSteerable({
          sessionId: row.id,
          message: "only the session owner can do this, even while control is shared",
        });
      }
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

    return {
      authorizeUser,
      authorizeTerminal,
      session,
      owned,
      stop,
      process,
      service,
      turn,
      agentRequest,
    };
  }),
);
