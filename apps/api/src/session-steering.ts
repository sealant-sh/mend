import {
  CurrentUser,
  NotFound,
  SessionControlView,
  SessionNotSteerable,
  SessionSharedControl,
  SharedControlPerson,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  ProjectsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  type SharedControlPerson as SharedControlPersonRow,
  type SignIn,
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
  canAskSharedControl,
  sharesControl,
  type SteeringFacts,
  type Viewer,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { type Actor, ProjectAccess, signInOf } from "./access.ts";

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
  /** The session's worktree runs each person as themselves (`SessionEngine.steersPerPerson`). */
  turnsOnSendersLogin = false,
): SessionControlView => {
  const steer = viewer !== null && canSteerSession(session, viewer.userId);
  return new SessionControlView({
    own: viewer !== null && session.ownerUserId === viewer.userId,
    steer,
    stop: steer || viewer?.role === "owner",
    // The switch clients that know only on and off press: on while anyone besides the owner
    // steers (docs/adr/0026, decision 7), so an organization owner can turn a grant off too.
    toggleSharedControl:
      viewer !== null && canToggleSharedControl(session, viewer, !sharesControl(session)),
    terminalInput: viewer !== null && canTypeInTerminal(session, viewer.userId),
    turnsOnSendersLogin,
  });
};

/**
 * A session's shared control as `viewer` reads it (docs/adr/0026, decision 7): everyone sees who
 * holds it; the owner sees every open ask, anyone else only their own.
 */
export const sharedControlView = (
  session: SteeringFacts & Pick<Session, "id" | "settledAt" | "harness">,
  viewer: Pick<Viewer, "userId" | "role"> | null,
  people: ReadonlyArray<SharedControlPersonRow>,
  turnsOnSendersLogin: boolean,
): SessionSharedControl => {
  const own = viewer !== null && session.ownerUserId === viewer.userId;
  const asked = people.filter(
    (person) => person.state === "asked" && (own || person.userId === viewer?.userId),
  );
  const mine = asked.some((person) => person.userId === viewer?.userId);
  return new SessionSharedControl({
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    everyoneSince: session.sharedControlEnabledAt,
    granted: people
      .filter((person) => person.state === "granted")
      .map((person) => new SharedControlPerson(person)),
    asked: asked.map((person) => new SharedControlPerson(person)),
    steer: viewer !== null && canSteerSession(session, viewer.userId),
    acts: {
      // opencode is one person's harness (docs/adr/0016, decision 6); a settled session takes no ask.
      ask:
        viewer !== null &&
        !mine &&
        session.settledAt === null &&
        session.harness !== "opencode" &&
        canAskSharedControl(session, viewer.userId),
      withdraw: mine,
      decide: own,
      takeBack: viewer !== null && canToggleSharedControl(session, viewer, false),
    },
    turnsOnSendersLogin,
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
export const requireOwnerRuns = Effect.fnUntraced(function* (
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
      actor: Actor,
    ) => Effect.Effect<Session, SteeringError>;
    /**
     * Who may reach a session's terminal, and whether they may type in it. Anyone who may steer
     * the session (visibility, then steering) reaches it with `steer: true`. Its owner, while still
     * a member of the project's organization but no longer able to see the project, only watches
     * (`steer: false`): their session keeps running, read-only to them, and their keys never reach
     * it (review 4 of mend#558, P1). Typing also needs `WorkspaceCaller.mayAct` in the route.
     */
    readonly authorizeTerminal: (
      session: Session,
      actor: Actor,
    ) => Effect.Effect<{ readonly session: Session; readonly steer: boolean }, SteeringError>;
    readonly session: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
    /**
     * The owner's own acts, closed to others even while control is shared: deleting the session,
     * renaming it, handing it off. Shared control lends steering, not the session itself.
     */
    readonly owned: (id: SessionId) => Effect.Effect<Session, SteeringError, CurrentUser>;
    /**
     * Stopping is steering, and an organization owner may also stop any session they can see. A
     * session's owner may always Stop it while they remain a member, even once they cannot see
     * its project: a Stop only ends and saves their own work.
     */
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
  | ProjectsRepo
  | ProjectAccess
  | ServicesRepo
  | SessionProcessesRepo
  | SessionsRepo
> = Layer.effect(
  SessionSteering,
  Effect.gen(function* () {
    const conversation = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const access = yield* ProjectAccess;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;

    const authorizeUser = Effect.fnUntraced(function* (session: Session, actor: Actor) {
      yield* access
        .projectAs(actor, session.projectId)
        .pipe(Effect.mapError(() => new NotFound({ id: session.id })));
      if (!canSteerSession(session, actor.userId)) return yield* refuse(session);
      return session;
    });

    const actsIn = (actor: Actor, session: Session) =>
      Effect.gen(function* () {
        const project = yield* projects
          .byId(session.projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: session.id })));
        const viewer = yield* access.viewerOf(actor);
        return viewer?.organizationId === project.organizationId;
      });

    const authorizeTerminal = Effect.fnUntraced(function* (session: Session, actor: Actor) {
      const steered = yield* authorizeUser(session, actor).pipe(Effect.result);
      if (steered._tag === "Success") return { session, steer: true };
      if (session.ownerUserId !== actor.userId) return yield* steered.failure;
      if (!(yield* actsIn(actor, session))) return yield* new NotFound({ id: session.id });
      // Watching only: no input reaches the terminal of a project they cannot see.
      return { session, steer: false };
    });

    const session = Effect.fnUntraced(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const row = yield* access.session(id);
      if (!canSteerSession(row, caller.user.id)) return yield* refuse(row);
      return row;
    });

    const owned = Effect.fnUntraced(function* (id: SessionId) {
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

    /**
     * The owner's own session, whether or not they can still see its project, while they remain
     * a member of its organization: what they may always Stop (owner decision 2026-10-06, review
     * 4 of mend#558). A Stop only ends and saves their own work. NotFound otherwise, as a hidden
     * session answers.
     */
    const ownSessionOfMember = Effect.fnUntraced(function* (id: SessionId, caller: SignIn) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      if (row.ownerUserId !== caller.userId) return yield* new NotFound({ id });
      if (!(yield* actsIn(caller, row).pipe(Effect.mapError(() => new NotFound({ id }))))) {
        return yield* new NotFound({ id });
      }
      return row;
    });

    const stop = Effect.fnUntraced(function* (id: SessionId) {
      const caller = yield* CurrentUser;
      const visible = yield* access.session(id).pipe(Effect.result);
      if (visible._tag === "Failure") {
        if (visible.failure._tag !== "NotFound") return yield* visible.failure;
        return yield* ownSessionOfMember(id, signInOf(caller));
      }
      const row = visible.success;
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

    const process = Effect.fnUntraced(function* (id: SessionProcessId) {
      const row = yield* processes.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { process: row, session: yield* through(id, row.sessionId) };
    });

    const service = Effect.fnUntraced(function* (id: ServiceId) {
      const row = yield* services.byId(id);
      if (row === null) return yield* new NotFound({ id });
      return { service: row, session: yield* through(id, row.sessionId) };
    });

    const turn = Effect.fnUntraced(function* (id: AgentTurnId) {
      const row = yield* conversation.byTurnId(id);
      if (row === null) return yield* new NotFound({ id });
      return { turn: row, session: yield* through(id, row.sessionId) };
    });

    const agentRequest = Effect.fnUntraced(function* (id: AgentRequestId) {
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
