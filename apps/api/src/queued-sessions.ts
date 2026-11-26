import {
  LaunchRequest,
  NewWorkbenchSession,
  NotFound,
  QueuedSession,
  QueuedSessionFailure,
  QueuedSessionMovedOn,
  type QueueSessionRequest,
  type StartQueuedSessionRequest,
} from "@mend/api-contracts";
import {
  OrganizationsRepo,
  type QueuedSessionChange,
  type QueuedSessionRow,
  type QueuedSessionState,
  QueuedSessionsRepo,
  type SignIn,
} from "@mend/db";
import type { QueuedSessionId } from "@mend/domain";
import { Cause, Context, DateTime, Duration, Effect, Layer, Result, Schema, Scope } from "effect";

import { type Actor, ProjectAccess } from "./access.ts";
import { type AdoptionEnd, Adoptions, type WatchedAdoption } from "./adoptions.ts";
import { type CreateSessionInput, SessionStart } from "./session-start.ts";

/** What a queued session asked for, as its row keeps it. */
const QueuedRequest = Schema.Struct({ session: NewWorkbenchSession, launch: LaunchRequest });
type QueuedRequest = typeof QueuedRequest.Type;
const encodeRequest = Schema.encodeEffect(QueuedRequest);
const decodeRequest = Schema.decodeUnknownEffect(QueuedRequest);

/** A started row is kept this long, so a client that was away reads which session it became. */
const STARTED_KEPT = Duration.days(7);

/** The words a restart leaves on what it interrupted. */
export const CLONE_STOPPED_BY_RESTART =
  "The clone stopped when the Mend server restarted. Clone the project again, then start this session.";
export const START_STOPPED_BY_RESTART =
  "The Mend server restarted while it was starting this session. Start it again.";

/**
 * Sessions started while their project still clones (SLNT-1099). A queued session waits on the
 * caller's adoption; when the clone finishes it starts through `SessionStart`, as the person who
 * queued it, exactly as `POST /projects/:id/sessions` and `POST /sessions/:id/launch` would have
 * started it then. When the clone fails it says so and waits for a start again or a cancel.
 *
 * Writers of one row: its clone's end (a fiber of this process), a cancel, a start again, and the
 * sweep after a restart. Each moves the row only from the state it saw (`QueuedSessionsRepo`), and
 * only the writer that moved it to `starting` creates the session: none starts it twice.
 */
export class QueuedSessions extends Context.Service<
  QueuedSessions,
  {
    readonly queue: (
      caller: SignIn,
      request: QueueSessionRequest,
    ) => Effect.Effect<QueuedSession, NotFound>;
    readonly list: (caller: SignIn) => Effect.Effect<ReadonlyArray<QueuedSession>>;
    readonly read: (caller: SignIn, id: QueuedSessionId) => Effect.Effect<QueuedSession, NotFound>;
    readonly start: (
      caller: SignIn,
      id: QueuedSessionId,
      target: StartQueuedSessionRequest,
    ) => Effect.Effect<QueuedSession, NotFound | QueuedSessionMovedOn>;
    readonly cancel: (
      caller: SignIn,
      id: QueuedSessionId,
    ) => Effect.Effect<void, NotFound | QueuedSessionMovedOn>;
  }
>()("@mend/api/QueuedSessions") {}

/** The create route's input, from the request as the person sent it. */
const createInputOf = (session: NewWorkbenchSession): CreateSessionInput => ({
  harness: session.harness,
  label: session.label,
  name: session.name,
  base: session.base,
  origin: "mend",
  autoLand: session.autoLand,
  ...(session.purpose === undefined ? {} : { purpose: session.purpose }),
  ...(session.harnessLayout === undefined ? {} : { harnessLayout: session.harnessLayout }),
});

const MOVED_ON: Record<QueuedSessionState, string> = {
  waiting: "This session is still waiting for its project's clone.",
  starting: "This session is starting; stop the session once it has started.",
  started: "This session has started.",
  failed: "This session did not start.",
};

const movedOn = (row: QueuedSessionRow) =>
  new QueuedSessionMovedOn({ id: row.id, state: row.state, message: MOVED_ON[row.state] });

const make: Effect.Effect<
  QueuedSessions["Service"],
  never,
  Adoptions | OrganizationsRepo | ProjectAccess | QueuedSessionsRepo | Scope.Scope | SessionStart
> = Effect.gen(function* () {
  const repo = yield* QueuedSessionsRepo;
  const adoptions = yield* Adoptions;
  const organizations = yield* OrganizationsRepo;
  const access = yield* ProjectAccess;
  const sessionStart = yield* SessionStart;
  const scope = yield* Scope.Scope;
  const bootedAt = yield* DateTime.nowAsDate;

  const viewOf = Effect.fnUntraced(function* (row: QueuedSessionRow) {
    const request = yield* decodeRequest(row.request).pipe(Effect.orDie);
    const clone =
      row.state === "waiting" ? yield* adoptions.read(row.ownerUserId, row.adoptionId) : null;
    return new QueuedSession({
      id: row.id,
      state: row.state,
      projectName: row.projectName,
      clone,
      failure:
        row.failureStep === null || row.failure === null
          ? null
          : new QueuedSessionFailure({ step: row.failureStep, message: row.failure }),
      sessionId: row.sessionId,
      session: request.session,
      launch: request.launch,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  const fail = (row: QueuedSessionRow, from: QueuedSessionState, failure: QueuedSessionChange) =>
    repo.change(row.id, [from], failure);

  /** Start a row this writer moved to `starting`: no other writer starts it. */
  const startClaimed = Effect.fn("QueuedSessions.startClaimed")(
    function* (row: QueuedSessionRow) {
      const request: QueuedRequest = yield* decodeRequest(row.request).pipe(Effect.orDie);
      const actor: Actor = { userId: row.ownerUserId, organizationId: row.organizationId };
      const created = yield* Effect.result(
        sessionStart.createAs(actor, row.projectId, createInputOf(request.session)),
      );
      if (Result.isFailure(created)) {
        const error = created.failure;
        yield* fail(row, "starting", {
          _tag: "Failed",
          step: "start",
          failure:
            error._tag === "NotFound"
              ? `The project ${row.projectName} is not there any more.`
              : error.message,
        });
        return;
      }
      const session = created.success;
      yield* repo.change(row.id, ["starting"], { _tag: "Started", sessionId: session.id });
      // The launch runs detached in the engine and settles the session itself when it fails, as
      // a launch from a client does; this only hands it over.
      yield* sessionStart.launchAs(row.ownerUserId, session, request.launch, {
        within: Duration.zero,
      });
    },
    (effect, row) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("queued session: the start failed").pipe(
            Effect.annotateLogs({ queuedSessionId: row.id, cause: Cause.pretty(cause) }),
            Effect.andThen(
              // A row still `starting` says so; one that started keeps its session.
              fail(row, "starting", {
                _tag: "Failed",
                step: "start",
                failure: "Mend could not start this session. The server log has the detail.",
              }),
            ),
            Effect.asVoid,
          ),
        ),
      ),
  );

  /** Settle a waiting row by its clone's end. */
  const settle = Effect.fnUntraced(function* (row: QueuedSessionRow, end: AdoptionEnd) {
    if (end._tag === "Failed") {
      yield* fail(row, "waiting", { _tag: "Failed", step: "clone", failure: end.failure });
      return;
    }
    const claimed = yield* repo.change(row.id, ["waiting"], {
      _tag: "Starting",
      projectId: end.projectId,
    });
    // Cancelled while it waited: nothing to start.
    if (claimed !== null) yield* startClaimed(claimed);
  });

  /**
   * Wait on the clone in this process's scope, past the request that queued it. A row only
   * returns to `waiting` from `failed`, which this waiter or the sweep wrote, so no older waiter
   * of the same row is still waiting.
   */
  const awaitClone = (row: QueuedSessionRow, watched: WatchedAdoption) =>
    watched.ended.pipe(
      Effect.flatMap((end) => settle(row, end)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const membershipOf = (caller: SignIn) => organizations.activeMembership(caller);

  const ownRow = Effect.fnUntraced(function* (caller: SignIn, id: QueuedSessionId) {
    const row = yield* repo.byId(id);
    if (row === null || row.ownerUserId !== caller.userId) return yield* new NotFound({ id });
    return row;
  });

  const queue = Effect.fnUntraced(function* (caller: SignIn, request: QueueSessionRequest) {
    const notFound = new NotFound({ id: request.adoptionId });
    const watched = yield* adoptions.watch(caller.userId, request.adoptionId.toLowerCase());
    if (watched === null) return yield* notFound;
    const membership = yield* membershipOf(caller);
    if (membership === null) return yield* notFound;
    const { row, inserted } = yield* repo.insert({
      id: request.id,
      ownerUserId: caller.userId,
      organizationId: membership.organization.id,
      adoptionId: request.adoptionId.toLowerCase(),
      projectName: watched.progress.name,
      projectId: watched.projectId,
      request: yield* encodeRequest({ session: request.session, launch: request.launch }).pipe(
        Effect.orDie,
      ),
    });
    // The same request again answers what the first one queued; another account's id is not
    // this caller's to read.
    if (row.ownerUserId !== caller.userId) return yield* new NotFound({ id: request.id });
    if (inserted) yield* awaitClone(row, watched);
    return yield* viewOf(row);
  });

  const list = Effect.fnUntraced(function* (caller: SignIn) {
    const membership = yield* membershipOf(caller);
    if (membership === null) return [];
    const rows = yield* repo.listUnstarted(caller.userId, membership.organization.id);
    return yield* Effect.forEach(rows, viewOf);
  });

  const read = Effect.fnUntraced(function* (caller: SignIn, id: QueuedSessionId) {
    return yield* viewOf(yield* ownRow(caller, id));
  });

  const start = Effect.fnUntraced(function* (
    caller: SignIn,
    id: QueuedSessionId,
    target: StartQueuedSessionRequest,
  ) {
    const row = yield* ownRow(caller, id);
    if (row.state !== "failed") return yield* movedOn(row);
    if ("adoptionId" in target) {
      const watched = yield* adoptions.watch(caller.userId, target.adoptionId.toLowerCase());
      if (watched === null) return yield* new NotFound({ id: target.adoptionId });
      const waiting = yield* repo.change(row.id, ["failed"], {
        _tag: "Waiting",
        adoptionId: target.adoptionId.toLowerCase(),
        projectName: watched.progress.name,
        projectId: watched.projectId,
      });
      if (waiting === null) return yield* movedOn(yield* ownRow(caller, id));
      yield* awaitClone(waiting, watched);
      return yield* viewOf(waiting);
    }
    // The person may see the project: it is theirs to start a session in.
    yield* access.projectAs(caller, target.projectId);
    const claimed = yield* repo.change(row.id, ["failed"], {
      _tag: "Starting",
      projectId: target.projectId,
    });
    if (claimed === null) return yield* movedOn(yield* ownRow(caller, id));
    yield* startClaimed(claimed).pipe(Effect.forkIn(scope));
    return yield* viewOf(claimed);
  });

  const cancel = Effect.fnUntraced(function* (caller: SignIn, id: QueuedSessionId) {
    yield* ownRow(caller, id);
    const removed = yield* repo.remove(id, ["waiting", "failed"]);
    if (removed === null) return yield* movedOn(yield* ownRow(caller, id));
  });

  /**
   * After a restart: this server runs one API process, whose clones the restart stopped. A row
   * still waiting starts if its clone finished before the restart, and fails otherwise; one caught
   * starting fails rather than risk a second session. Only rows last changed before this process
   * began: a session queued since waits on a clone this process runs.
   */
  const sweep = Effect.gen(function* () {
    for (const row of yield* repo.listLeftBehind(["waiting", "starting"], bootedAt)) {
      if (row.state === "starting") {
        yield* fail(row, "starting", {
          _tag: "Failed",
          step: "start",
          failure: START_STOPPED_BY_RESTART,
        });
        continue;
      }
      const cloned = yield* access
        .projectAs({ userId: row.ownerUserId, organizationId: row.organizationId }, row.projectId)
        .pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
      if (!cloned) {
        yield* fail(row, "waiting", {
          _tag: "Failed",
          step: "clone",
          failure: CLONE_STOPPED_BY_RESTART,
        });
        continue;
      }
      const claimed = yield* repo.change(row.id, ["waiting"], {
        _tag: "Starting",
        projectId: row.projectId,
      });
      if (claimed !== null) yield* startClaimed(claimed).pipe(Effect.forkIn(scope));
    }
    yield* repo.forgetStarted(new Date(bootedAt.getTime() - Duration.toMillis(STARTED_KEPT)));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("queued sessions: the sweep after a restart failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
  );
  yield* sweep;

  return { queue, list, read, start, cancel };
});

/** The API process's queued sessions, swept once as it starts. */
export const QueuedSessionsLive: Layer.Layer<
  QueuedSessions,
  never,
  Adoptions | OrganizationsRepo | ProjectAccess | QueuedSessionsRepo | SessionStart
> = Layer.effect(QueuedSessions, make);
