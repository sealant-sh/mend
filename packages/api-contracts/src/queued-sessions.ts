import { ProjectId, QueuedSessionId, SessionId, Timestamp } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { LaunchRequest, NewWorkbenchSession } from "./project-environment.ts";
import { AdoptionProgress } from "./workbench-views.ts";

/**
 * Start a session in a project that is still cloning (SLNT-1099). The session waits, and starts
 * by itself, as these two requests would start it, once the clone finishes.
 */
export class QueueSessionRequest extends Schema.Class<QueueSessionRequest>("QueueSessionRequest")({
  /** The client's: a request sent again with the same id queues the session once. */
  id: QueuedSessionId,
  /** The caller's own adoption that is cloning the project (`AdoptProject.adoptionId`). */
  adoptionId: Schema.String.check(Schema.isUUID()),
  /** What `POST /projects/:id/sessions` takes: the agent, the worktree, automatic landing. */
  session: NewWorkbenchSession,
  /** What `POST /sessions/:id/launch` takes: the prompt, mode, model, effort and the rest. */
  launch: LaunchRequest,
}) {}

/** Start a failed one again: once its project is cloned, or on a new clone of it. */
export const StartQueuedSessionRequest = Schema.Union([
  /** The project is cloned now: start the session in it. */
  Schema.Struct({ projectId: ProjectId }),
  /** A new clone of the project is running: wait for that one. */
  Schema.Struct({ adoptionId: Schema.String.check(Schema.isUUID()) }),
]);
export type StartQueuedSessionRequest = typeof StartQueuedSessionRequest.Type;

/** Why a queued session did not start: its project's clone failed, or starting it then did. */
export class QueuedSessionFailure extends Schema.Class<QueuedSessionFailure>(
  "QueuedSessionFailure",
)({
  step: Schema.Literals(["clone", "start"]),
  /** Mend's sentence: the clone's own reason, or why the session could not start. */
  message: Schema.String,
}) {}

/**
 * A session started while its project still clones. `waiting`: for the clone, whose progress is
 * `clone` while this server runs it. `starting`: the project is cloned and Mend is starting the
 * session. `started`: the session exists, `sessionId`; read it at `/sessions/:id` from now on.
 * `failed`: `failure` says which step and why; start it again or cancel it.
 */
export class QueuedSession extends Schema.Class<QueuedSession>("QueuedSession")({
  id: QueuedSessionId,
  state: Schema.Literals(["waiting", "starting", "started", "failed"]),
  projectName: Schema.String,
  /** How far the clone got, while it runs on this server; null otherwise. */
  clone: Schema.NullOr(AdoptionProgress),
  failure: Schema.NullOr(QueuedSessionFailure),
  sessionId: Schema.NullOr(SessionId),
  /** What the person asked for, as they sent it. */
  session: NewWorkbenchSession,
  launch: LaunchRequest,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** The queued session has moved on from the state the request needs: `state` is where it is. */
export class QueuedSessionMovedOn extends Schema.TaggedError<QueuedSessionMovedOn>()(
  "QueuedSessionMovedOn",
  {
    id: Schema.String,
    state: Schema.Literals(["waiting", "starting", "started", "failed"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** Sessions started while their project still clones; each is only its owner's. */
export const queuedSessionsGroup = HttpApiGroup.make("queuedSessions")
  .add(
    // NotFound: the adoption is not the caller's, or this server no longer knows it.
    HttpApiEndpoint.post("queue", "/queued-sessions", {
      payload: QueueSessionRequest,
      success: QueuedSession,
      error: NotFound,
    }),
  )
  .add(
    // The caller's in their current organization that have not started: waiting, starting, failed.
    HttpApiEndpoint.get("list", "/queued-sessions", {
      success: Schema.Array(QueuedSession),
    }),
  )
  .add(
    HttpApiEndpoint.get("read", "/queued-sessions/:id", {
      params: { id: QueuedSessionId },
      success: QueuedSession,
      error: NotFound,
    }),
  )
  .add(
    // Only a failed one; NotFound when the project or the adoption is not the caller's.
    HttpApiEndpoint.post("start", "/queued-sessions/:id/start", {
      params: { id: QueuedSessionId },
      payload: StartQueuedSessionRequest,
      success: QueuedSession,
      error: [NotFound, QueuedSessionMovedOn],
    }),
  )
  .add(
    // A waiting or failed one; once it is starting, the session is the thing to stop.
    HttpApiEndpoint.delete("cancel", "/queued-sessions/:id", {
      params: { id: QueuedSessionId },
      error: [NotFound, QueuedSessionMovedOn],
    }),
  )
  .middleware(AuthMiddleware);
