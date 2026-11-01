import {
  AgentConversationRepo,
  CheckpointsRepo,
  MendEvent,
  type PreviewPreparationClaim,
  PreviewPreparationsRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { SessionId } from "@mend/domain";
import {
  type AgentTurn,
  coveredTurns,
  type PreviewPreparationDecision,
  type PreviewPreparationHold,
  previewTurnStartId,
  type Session,
} from "@mend/domain/workbench";
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { busPayloads, EventBus } from "./events-bus.ts";

const TURN_FRESHNESS_MS = 15 * 60_000;
export const PREPARATION_LEASE_MS = 2 * 60_000;
export const PREPARATION_SWEEP_INTERVAL = Duration.seconds(60);
const FLUSH_ATTEMPTS = 3;
const FLUSH_PAUSE = Duration.seconds(15);

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

const skipped = (why: string): PreviewPreparationDecision => ({ _tag: "Skipped", why });
const SUPERSEDED: PreviewPreparationDecision = { _tag: "Superseded" };
const NOT_CAPTURED: PreviewPreparationDecision = { _tag: "NotCaptured" };
const NO_CHANGE: PreviewPreparationDecision = { _tag: "NoChange" };

export interface PreviewPreparationOptions {
  readonly now?: () => number;
  readonly flushAttempts?: number;
  readonly flushPause?: Duration.Duration;
  readonly leaseMs?: number;
  readonly sweepInterval?: Duration.Duration;
}

export const makePreviewPreparation = (options: PreviewPreparationOptions = {}) =>
  Effect.gen(function* () {
    const preparations = yield* PreviewPreparationsRepo;
    const conversations = yield* AgentConversationRepo;
    const sessions = yield* SessionsRepo;
    const worktrees = yield* WorktreesRepo;
    const changes = yield* WorktreeChangesRepo;
    const checkpoints = yield* CheckpointsRepo;
    const reads = yield* WorktreeReads;
    const engine = yield* SessionEngine;
    const clock = yield* Clock.Clock;
    const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
    const flushAttempts = options.flushAttempts ?? FLUSH_ATTEMPTS;
    const flushPause = options.flushPause ?? FLUSH_PAUSE;
    const leaseMs = options.leaseMs ?? PREPARATION_LEASE_MS;

    const caughtUp = (session: Session, turn: AgentTurn) =>
      Effect.gen(function* () {
        for (let attempt = 1; attempt <= flushAttempts; attempt += 1) {
          const observed = yield* engine
            .flushCaptures(session.id, `preview · turn ${turn.ordinal}`)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed("none" as const)));
          if (observed !== "incomplete") return true;
          if (attempt < flushAttempts) yield* Effect.sleep(flushPause);
        }
        return false;
      });

    const changedSince = (session: Session, since: Date) =>
      Effect.gen(function* () {
        if ((yield* changes.byWorktree(session.worktreeId)) === null) return false;
        const worktree = yield* worktrees.byId(session.worktreeId);
        const before = yield* checkpoints.latestForWorktreeAt(worktree.id, since);
        const changed = yield* reads.changedFiles(
          session.projectId,
          worktree.id,
          before?.sha ?? worktree.baseSha,
          { exactHead: true },
        );
        return changed.value.length > 0;
      });

    const changeOf = (session: Session, turn: AgentTurn, since: Date) =>
      Effect.gen(function* () {
        if (!(yield* caughtUp(session, turn))) return NOT_CAPTURED;
        return (yield* changedSince(session, since)) ? null : NO_CHANGE;
      }).pipe(
        Effect.catchTags({
          WorktreeNotFoundError: () => Effect.succeed(skipped("the worktree is gone")),
          ProjectNotFoundError: () => Effect.succeed(skipped("the project is gone")),
          GitError: () => Effect.succeed(NOT_CAPTURED),
          WorktreeNotCapturedError: () => Effect.succeed(NOT_CAPTURED),
        }),
      );

    const laterTurn = (session: Session, turn: AgentTurn) =>
      Effect.map(conversations.listTurns(session.id), (turns) =>
        turns.some((other) => other.ordinal > turn.ordinal),
      );

    const decide = Effect.fn("PreviewPreparation.decide")(function* (
      session: Session,
      turn: AgentTurn,
      hold: PreviewPreparationHold,
    ) {
      if (session.purpose === "setup")
        return skipped("setup sessions write instructions; nothing starts");
      const turns = yield* conversations.listTurns(session.id);
      if (turns.some((other) => other.ordinal > turn.ordinal)) return SUPERSEDED;
      if (now() - (turn.endedAt ?? turn.createdAt).getTime() > TURN_FRESHNESS_MS) {
        return skipped("ended long ago");
      }
      const covered = coveredTurns(turns, yield* preparations.left(session.id), turn);
      if (!covered.some((candidate) => candidate.status === "completed")) {
        return skipped(`the turn ${turn.status}`);
      }
      const first = covered[0] ?? turn;
      const unchanged = yield* changeOf(session, turn, first.startedAt ?? first.createdAt);
      if (unchanged !== null) return unchanged;
      if (yield* laterTurn(session, turn)) return SUPERSEDED;
      return yield* engine.preparePreview(session.id, turn.id, hold).pipe(
        Effect.catchTags({
          SessionNotFoundError: () => Effect.succeed(skipped("the session is gone")),
          ProjectNotFoundError: () => Effect.succeed(skipped("the project is gone")),
        }),
      );
    });

    const holdClaim = (claim: PreviewPreparationClaim, lost: Deferred.Deferred<void>) =>
      Effect.sleep(Duration.millis(leaseMs / 3)).pipe(
        Effect.andThen(
          preparations
            .renew(claim, leaseMs)
            .pipe(Effect.timeoutOption(Duration.millis((leaseMs * 2) / 3)), Effect.exit),
        ),
        Effect.map(
          (renewed) => Exit.isSuccess(renewed) && Option.getOrElse(renewed.value, () => false),
        ),
        Effect.repeat({ while: (held) => held }),
        Effect.andThen(Deferred.succeed(lost, undefined)),
      );

    /**
     * Losing the claim ends the preparation where it stands: the engine's start is admitted only
     * while the claim holds (`PreviewPreparationHold.holds`), and the turn is left for the pass
     * that retakes it.
     */
    const prepare = Effect.fn("PreviewPreparation.prepare")(function* (
      session: Session,
      turn: AgentTurn,
      claim: PreviewPreparationClaim,
    ) {
      const lost = yield* Deferred.make<void>();
      yield* Effect.forkScoped(holdClaim(claim, lost));
      const hold: PreviewPreparationHold = {
        report: (starting) =>
          preparations.progress(claim, { ...starting, startId: previewTurnStartId(turn.id) }).pipe(
            Effect.tap((held) =>
              held === "Lost" ? Deferred.succeed(lost, undefined) : Effect.void,
            ),
            Effect.map((held) => held === "Held"),
          ),
        holds: preparations.renew(claim, leaseMs),
      };
      const decision = yield* decide(session, turn, hold).pipe(
        Effect.map(Option.some),
        Effect.raceFirst(Deferred.await(lost).pipe(Effect.as(Option.none()))),
      );
      const annotations = { sessionId: session.id, turnId: turn.id, ordinal: turn.ordinal };
      if (Option.isNone(decision)) {
        return yield* Effect.logWarning(
          "preview preparation: the claim was lost before it decided · a later pass retakes it",
        ).pipe(Effect.annotateLogs(annotations));
      }
      yield* Effect.logInfo(`preview preparation: ${decision.value._tag}`).pipe(
        Effect.annotateLogs(annotations),
      );
      if (!(yield* preparations.decide(claim, decision.value))) {
        yield* Effect.logWarning("preview preparation: the claim lapsed before it decided").pipe(
          Effect.annotateLogs(annotations),
        );
      }
    }, Effect.scoped);

    const consider = Effect.fn("PreviewPreparation.consider")(function* (sessionId: SessionId) {
      const undecided = yield* preparations.undecided(sessionId);
      if (undecided.length === 0) return;
      const session = yield* sessions
        .byId(sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null) return;
      const turns = yield* conversations.listTurns(sessionId);
      for (const turnId of undecided) {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (turn === undefined) continue;
        const claim = yield* preparations.claim(turnId, leaseMs);
        if (claim === null) continue;
        yield* prepare(session, turn, claim).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("preview preparation: the turn was not decided").pipe(
              Effect.annotateLogs({ sessionId, turnId, cause: Cause.pretty(cause) }),
            ),
          ),
        );
      }
    });

    const activeSessions = Effect.map(sessions.listActive(), (active) =>
      active.map((session) => session.id),
    );

    return { consider, activeSessions };
  });

export const previewPreparation = (
  events: Stream.Stream<string, SqlError>,
  options: PreviewPreparationOptions = {},
) =>
  Effect.gen(function* () {
    const preparer = yield* makePreviewPreparation(options);
    const scope = yield* Effect.scope;
    const looking = new Set<string>();
    const again = new Set<string>();
    const look = (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (looking.has(sessionId)) {
          again.add(sessionId);
          return Effect.void;
        }
        looking.add(sessionId);
        return preparer.consider(SessionId.make(sessionId)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("preview preparation: session look failed").pipe(
              Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              looking.delete(sessionId);
              return again.delete(sessionId) ? look(sessionId) : Effect.void;
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });
    yield* Effect.forkScoped(
      preparer.activeSessions.pipe(
        Effect.flatMap((ids) => Effect.forEach(ids, look, { discard: true })),
        Effect.catchCause((cause) =>
          Effect.logWarning("preview preparation: pass failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.repeat(Schedule.spaced(options.sweepInterval ?? PREPARATION_SWEEP_INTERVAL)),
      ),
    );
    yield* events.pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) =>
            event.type === "agent-conversation" ? look(event.sessionId) : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("preview preparation: event handling failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("preview preparation: listen stream ended").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  });

/** Hears turns end on the process's events bus: one LISTEN per process, not one per worker. */
export const PreviewPreparationLive: Layer.Layer<
  never,
  never,
  | EventBus
  | AgentConversationRepo
  | CheckpointsRepo
  | PreviewPreparationsRepo
  | SessionEngine
  | SessionsRepo
  | WorktreeChangesRepo
  | WorktreeReads
  | WorktreesRepo
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const subscription = yield* (yield* EventBus).subscribe;
    yield* previewPreparation(busPayloads(subscription));
  }),
);
