import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Session } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, BudgetExceeded } from "./common.ts";
import { LaunchRequest, NewWorkbenchSession } from "./project-environment.ts";
import { HarnessLayoutRefused } from "./sessions.ts";
import { RemovalInProgress, StoreFailure } from "./workbench-views.ts";
import { NewWorktreeSession, WorktreeNotFound } from "./worktrees.ts";

/** Where a start makes its session: a new worktree of a project, or one that exists. */
export const SessionStartTarget = Schema.Union([
  /** What `POST /projects/:id/sessions` takes. */
  Schema.TaggedStruct("Project", { projectId: ProjectId, session: NewWorkbenchSession }),
  /** What `POST /worktrees/:id/sessions` takes. */
  Schema.TaggedStruct("Worktree", { worktreeId: WorktreeId, session: NewWorktreeSession }),
]);
export type SessionStartTarget = typeof SessionStartTarget.Type;

/**
 * Make a session and launch it, in one request (SLNT-1239). Mend makes and launches it whatever
 * becomes of the client that asked, so a page closed or reloaded the moment it sent this never
 * leaves a session that doesn't launch.
 */
export class StartSessionRequest extends Schema.Class<StartSessionRequest>("StartSessionRequest")({
  /**
   * The client's own id for this start (a UUID): a page reloaded before Mend answered reads it
   * back (`GET /session-starts/:id`), and the same request again starts no second session.
   */
  key: Schema.String.check(Schema.isUUID()),
  target: SessionStartTarget,
  /** What `POST /sessions/:id/launch` takes: the first message, mode, model, effort. */
  launch: LaunchRequest,
}) {}

/**
 * A start, by its key. `making`: Mend has it and is making the session. `made`: the session is
 * `sessionId`. `failed`: `failure` is why there is none. `unknown`: Mend has no start by this key,
 * because the request never reached it, or it was forgotten (a week on), or its session was
 * removed.
 */
export class SessionStartRead extends Schema.Class<SessionStartRead>("SessionStartRead")({
  key: Schema.String,
  state: Schema.Literals(["unknown", "making", "made", "failed"]),
  sessionId: Schema.NullOr(SessionId),
  failure: Schema.NullOr(Schema.String),
}) {}

/** Starts named by the client's key; each is only its owner's. */
export const sessionStartsGroup = HttpApiGroup.make("sessionStarts")
  .add(
    // Answers the session once it is made and its launch is under way (its first message is in
    // its conversation then), or once the launch has ended, whichever is first; a launch still
    // going after the launch window goes on and the session says where it is.
    HttpApiEndpoint.post("start", "/session-starts", {
      payload: StartSessionRequest,
      success: Session,
      error: [
        NotFound,
        WorktreeNotFound,
        StoreFailure,
        BudgetExceeded,
        HarnessLayoutRefused,
        RemovalInProgress,
      ],
    }),
  )
  .add(
    // By the start's key, the UUID its client chose (`StartSessionRequest.key`).
    HttpApiEndpoint.get("read", "/session-starts/:id", {
      params: { id: Schema.String.check(Schema.isUUID()) },
      success: SessionStartRead,
    }),
  )
  .middleware(AuthMiddleware);
