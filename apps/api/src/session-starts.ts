import {
  type BudgetExceeded,
  type HarnessLayoutRefused,
  type NotFound,
  type RemovalInProgress,
  type SessionAgentLive,
  type SessionMovedOn,
  SessionStartRead,
  type StartSessionRequest,
  StoreFailure,
  WorktreeNotFound,
} from "@mend/api-contracts";
import { SessionsRepo, SessionStartsRepo } from "@mend/db";
import type { Session, Worktree } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { reportCause } from "@mend/telemetry";
import { Cause, Context, DateTime, Deferred, Duration, Effect, Layer, Option } from "effect";

import type { Actor } from "./access.ts";
import { LAUNCH_ANSWER_WINDOW, SessionStart } from "./session-start.ts";

/** A start's key is kept this long, so a page that was away a while reads which session it made. */
export const SESSION_STARTS_KEPT = Duration.days(7);

/** What a start's request can be refused with: Mend didn't make the session. */
export type StartRefused =
  | NotFound
  | WorktreeNotFound
  | StoreFailure
  | BudgetExceeded
  | HarnessLayoutRefused
  | RemovalInProgress;

/** What making a session or launching it can be refused with. */
export type StartRefusal = StartRefused | SessionMovedOn | SessionAgentLive;

/** The words a start that never made its session keeps for a page that reads its key. */
export const refusalWords = (refusal: StartRefusal): string => {
  switch (refusal._tag) {
    case "NotFound":
      return "The project isn't there any more.";
    case "WorktreeNotFound":
      return "The worktree isn't there any more.";
    default:
      return refusal.message === "" ? "Mend couldn't start this session." : refusal.message;
  }
};

/** How often the same start sent again reads whether the first has made its session. */
const AGAIN_READ = Duration.millis(250);

/** What a start that died before it made its session says. */
export const START_BROKE = "Mend couldn't start this session. The server log has the detail.";

/**
 * Starts named by the client's key (SLNT-1239). One request makes the session and launches it:
 * both run in the engine's own lifetime, detached from the request, so a client that goes away
 * once Mend has the request, a closed tab or a reload, can't leave a session made and never
 * launched. The key is stored with the session made, or with the reason there is none, so a page
 * reloaded before Mend answered finds its start again.
 */
export class SessionStarts extends Context.Service<
  SessionStarts,
  {
    /**
     * Make the session (in `request.target`; a worktree target needs `worktree`, the one the caller
     * resolved and may see) and launch it. Answers once it is made and its launch is under way, or
     * the launch has ended, or the launch window has passed: the launch goes on.
     */
    readonly start: (
      actor: Actor,
      request: StartSessionRequest,
      worktree: Worktree | null,
    ) => Effect.Effect<Session, StartRefused>;
    readonly read: (actor: Actor, key: string) => Effect.Effect<SessionStartRead>;
  }
>()("@mend/api/SessionStarts") {}

const make: Effect.Effect<
  SessionStarts["Service"],
  never,
  SessionEngine | SessionStart | SessionStartsRepo | SessionsRepo
> = Effect.gen(function* () {
  const engine = yield* SessionEngine;
  const sessionStart = yield* SessionStart;
  const repo = yield* SessionStartsRepo;
  const sessions = yield* SessionsRepo;

  const read = Effect.fnUntraced(function* (actor: Actor, key: string) {
    const row = yield* repo.read(actor.userId, key);
    return new SessionStartRead({
      key,
      state:
        row === null
          ? "unknown"
          : row.sessionId !== null
            ? "made"
            : row.failure !== null
              ? "failed"
              : "making",
      sessionId: row?.sessionId ?? null,
      failure: row?.failure ?? null,
    });
  });

  /**
   * The same key again (a client that sent its start twice): what the first request made, once it
   * has made it, or the reason it didn't. Never a second session.
   */
  const again = Effect.fnUntraced(function* (actor: Actor, key: string) {
    const until = (yield* DateTime.nowAsDate).getTime() + Duration.toMillis(LAUNCH_ANSWER_WINDOW);
    for (;;) {
      const row = yield* repo.read(actor.userId, key);
      if (row?.sessionId != null)
        return yield* sessions
          .byId(row.sessionId)
          .pipe(
            Effect.catchTag("SessionNotFoundError", () =>
              Effect.fail(new StoreFailure({ message: "That session was removed." })),
            ),
          );
      if (row?.failure != null) return yield* new StoreFailure({ message: row.failure });
      if ((yield* DateTime.nowAsDate).getTime() > until)
        return yield* new StoreFailure({
          message: "Mend is still making this session. It shows in your sessions once it's made.",
        });
      yield* Effect.sleep(AGAIN_READ);
    }
  });

  const start = Effect.fnUntraced(function* (
    actor: Actor,
    request: StartSessionRequest,
    worktree: Worktree | null,
  ) {
    const owner = actor.userId;
    const { key, target } = request;
    const now = yield* DateTime.nowAsDate;
    yield* repo.forgetBefore(new Date(now.getTime() - Duration.toMillis(SESSION_STARTS_KEPT)));
    if (!(yield* repo.claim(owner, key))) return yield* again(actor, key);
    const makeSession: Effect.Effect<Session, StartRefusal> =
      target._tag === "Project"
        ? sessionStart.createAs(actor, target.projectId, {
            harness: target.session.harness,
            label: target.session.label,
            name: target.session.name,
            base: target.session.base,
            origin: "mend",
            autoLand: target.session.autoLand,
            ...(target.session.purpose === undefined ? {} : { purpose: target.session.purpose }),
            ...(target.session.harnessLayout === undefined
              ? {}
              : { harnessLayout: target.session.harnessLayout }),
          })
        : worktree !== null && worktree.id === target.worktreeId
          ? sessionStart.createInWorktreeAs(actor, worktree, {
              harness: target.session.harness,
              label: target.session.label,
              autoLand: target.session.autoLand,
            })
          : Effect.fail(new WorktreeNotFound({ id: target.worktreeId }));
    const made = yield* Deferred.make<Session, StartRefusal>();
    const underWay = yield* Deferred.make<void>();
    const work = makeSession.pipe(
      Effect.tap((session) =>
        repo
          .made(owner, key, session.id)
          .pipe(Effect.andThen(Effect.annotateCurrentSpan("mend.session_id", session.id))),
      ),
      Effect.tapError((refusal) => repo.failed(owner, key, refusalWords(refusal))),
      Effect.tapDefect(() => repo.failed(owner, key, START_BROKE)),
      // Whatever became of the making, the request waiting on it hears.
      Effect.onExit((exit) => Deferred.done(made, exit)),
      Effect.flatMap((session) =>
        sessionStart
          .launchAs(owner, session, request.launch, {
            onAdmitted: Deferred.succeed(underWay, undefined).pipe(Effect.asVoid),
          })
          .pipe(
            // A launch refused once the session is made never leaves it reading Starting.
            Effect.catch((refusal) =>
              sessionStart.settleUnlaunched(session, refusalWords(refusal)),
            ),
          ),
      ),
      Effect.ensuring(Deferred.succeed(underWay, undefined)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("session start: the start failed").pipe(
              Effect.annotateLogs({ key, cause: Cause.pretty(cause) }),
              // A refusal is the person's answer; a defect is the server's, and Sentry hears of it.
              Effect.andThen(
                Cause.hasDies(cause)
                  ? reportCause(cause, { operation: "mend.session.start" })
                  : Effect.void,
              ),
            ),
      ),
    );
    // In the engine's lifetime: the client going away interrupts only this request's wait. The
    // start is one span that outlives the request, parented on it explicitly (SLNT-1349), so the
    // engine's provisioning and every sealant call beneath it join the request's trace.
    const requestSpan = yield* Effect.option(Effect.currentParentSpan);
    yield* engine.detach(
      work.pipe(
        Effect.withSpan("mend.session.start", {
          ...(Option.isSome(requestSpan) ? { parent: requestSpan.value } : {}),
          attributes: {
            "mend.session.target": target._tag === "Project" ? "project" : "worktree",
            "mend.harness": target.session.harness,
          },
        }),
      ),
    );
    const session = yield* Deferred.await(made).pipe(
      // Only a launch refuses with these, and a new session's never does: said as they are.
      Effect.catchTags({
        SessionMovedOn: (refusal) => Effect.fail(new StoreFailure({ message: refusal.message })),
        SessionAgentLive: (refusal) => Effect.fail(new StoreFailure({ message: refusal.message })),
      }),
    );
    yield* Deferred.await(underWay).pipe(Effect.timeoutOption(LAUNCH_ANSWER_WINDOW));
    return yield* sessions
      .byId(session.id)
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(session)));
  });

  return { start, read };
});

export const SessionStartsLive: Layer.Layer<
  SessionStarts,
  never,
  SessionEngine | SessionStart | SessionStartsRepo | SessionsRepo
> = Layer.effect(SessionStarts, make);
