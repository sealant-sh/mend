import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  ChangeLandingsRepo,
  MEND_EVENTS_CHANNEL,
  MendEvent,
  ProjectsRepo,
  SessionsRepo,
  SettingsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { type ChangeLandingId, SessionId } from "@mend/domain";
import {
  type AgentTurn,
  changeOwnerOf,
  type NotLandedReason,
  notLandedLine,
  type Project,
  type RequestIntentReading,
  requestOfTurn,
  resolveAutoLand,
  type Session,
  type TurnLanding,
} from "@mend/domain/workbench";
import { RequestIntentReader } from "@mend/inference";
import {
  afterTheIntent,
  type ChangeFacts,
  heldBack,
  planTurn,
  recordedIntent,
  type HeldBack,
  type SkippedWhy,
  withTheChange,
} from "@mend/landing";
import { NetworkConfig } from "@mend/network";
import { asSealantUser } from "@mend/sealant";
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import { Cause, Duration, Effect, Layer, Result, Schema, Stream } from "effect";

import { OwnerLanding } from "./owner-landing.ts";

/**
 * Automatic landing (docs/adr/0007-landing.md, "Automatic landing"): after each turn that
 * completes, Mend lands the change when automatic landing is on for the session and the turn
 * passes the ADR's checks, in order (`planTurn`, the request's intent with `afterTheIntent`, then
 * the change with `withTheChange`). The first landing opens the pull request; later ones update
 * it. A request that asks to land the change as it stands ("land it", "open a PR") lands it for
 * the change's owner even when the turn changed nothing, and, in a Slack thread, even when
 * automatic landing is off: the thread has no Land panel.
 *
 * It listens on `mend_events` beside the notifier and the Slack reporter, and looks again at a
 * session whenever its conversation moves. Each ended turn is decided once: a worker claims the
 * turn in Postgres (`claimTurnLanding`) before it reads anything, so a second worker, or a second
 * look, never lands it twice. The decision is recorded on the turn and logged: `attempted` with
 * the landing it started, the reason it did not land, or `skipped`.
 *
 * Before it reads the change for a landing, Mend asks the executor to flush its captures
 * (`SessionEngine.flushCaptures`), a bounded number of times: a stale head is neither landed nor
 * called empty, and a turn whose captures never caught up reads
 * `not landed · the change was not captured`. Nothing else retries. A landing that is refused or
 * fails is recorded as such, and the next completed turn, the owner's button, or `mend land` is
 * the next attempt.
 */

/** A turn that ended longer ago than this is history: decided `skipped`, never landed. */
const TURN_FRESHNESS_MS = 15 * 60_000;
/** How many earlier requests the intent reading sees as context. */
const CONTEXT_TURNS = 5;

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

/** How often Mend asks the executor to flush before it calls a turn's change not captured. */
const FLUSH_ATTEMPTS = 3;
/** The pause between those asks; each ask is itself bounded by the engine's flush timeout. */
const FLUSH_PAUSE = Duration.seconds(15);

interface Decided {
  readonly landing: TurnLanding;
  readonly landingId: ChangeLandingId | null;
  /** Why, in the words the log carries. */
  readonly why: string;
}

const attempted = (landingId: ChangeLandingId): Decided => ({
  landing: "attempted",
  landingId,
  why: "landed",
});

const skippedFor = (why: SkippedWhy | string): Decided => ({
  landing: "skipped",
  landingId: null,
  why,
});

const notLanded = (reason: NotLandedReason): Decided => ({
  landing: reason,
  landingId: null,
  why: notLandedLine(reason),
});

/** A decision short of landing, as the turn records it. */
const decidedAs = (decision: HeldBack): Decided =>
  decision._tag === "skipped" ? skippedFor(decision.why) : notLanded(decision.reason);

/** A change Mend could not bring up to the turn: neither landed nor called empty. */
const NOT_CAPTURED: ChangeFacts = { captured: false, empty: false, newSinceLanding: false };

const ended = (turn: AgentTurn): boolean => turn.status !== "queued" && turn.status !== "running";

export interface AutomaticLandingOptions {
  readonly now?: () => number;
  /** How often to ask for a flush before a change reads as not captured; 3 by default. */
  readonly flushAttempts?: number;
  /** The pause between those asks; 15 s by default. */
  readonly flushPause?: Duration.Duration;
}

export const makeAutomaticLanding = (options: AutomaticLandingOptions = {}) =>
  Effect.gen(function* () {
    const conversations = yield* AgentConversationRepo;
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const settingsRepo = yield* SettingsRepo;
    const worktrees = yield* WorktreesRepo;
    const changes = yield* WorktreeChangesRepo;
    const landings = yield* ChangeLandingsRepo;
    const threads = yield* SlackThreadsRepo;
    const installs = yield* SlackInstallsRepo;
    const reads = yield* WorktreeReads;
    const reader = yield* RequestIntentReader;
    const lander = yield* OwnerLanding;
    const network = yield* NetworkConfig;
    const engine = yield* SessionEngine;
    const now = options.now ?? Date.now;
    const flushAttempts = options.flushAttempts ?? FLUSH_ATTEMPTS;
    const flushPause = options.flushPause ?? FLUSH_PAUSE;

    /** The Slack install a Slack session's thread belongs to, when it still has one. */
    const installOf = (session: Session) =>
      Effect.gen(function* () {
        if (session.origin !== "slack") return null;
        const thread = yield* threads.forSession(session.id);
        return thread === null ? null : yield* installs.byTeam(thread.teamId);
      });

    /** Whether automatic landing is on for the session ("When it is on"). */
    const landsOn = (session: Session, project: Project) =>
      Effect.gen(function* () {
        const settings = yield* settingsRepo.forOrganization(project.organizationId);
        const install = yield* installOf(session);
        return resolveAutoLand({
          origin: session.origin,
          project: project.autoLand,
          settings: settings.autoLand,
          session: session.autoLand,
          // The Slack app's "Land automatically" is on by default, as it is in Cursor.
          slack: install?.settings.landAutomatically ?? true,
        });
      });

    /**
     * The request's intent: what an option or Slack's thread reading already recorded, else one
     * small call on the login of whoever sent the turn, recorded on the turn (docs/adr/0008,
     * "Whose login pays"). A turn with no recorded sender is read on no one's login and reads as
     * not read, as does anything else unreadable.
     */
    const intentOf = (session: Session, turn: AgentTurn, turns: ReadonlyArray<AgentTurn>) =>
      Effect.gen(function* () {
        const recorded = recordedIntent(turn);
        if (recorded !== null) return recorded;
        const earlier = turns
          .filter((other) => other.ordinal < turn.ordinal)
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .slice(-CONTEXT_TURNS)
          .map((other) => ({
            author: other.author === session.ownerUserId ? "the owner" : "someone else",
            text: requestOfTurn(other.input),
          }));
        const reading = yield* reader
          .read({ request: requestOfTurn(turn.input), context: earlier })
          .pipe(
            asSealantUser(turn.author),
            Effect.map((intent): RequestIntentReading => ({ intent, source: "read" })),
            Effect.catch((error) =>
              Effect.logInfo("automatic landing: the request's intent was not read").pipe(
                Effect.annotateLogs({
                  sessionId: session.id,
                  turnId: turn.id,
                  cause: error.message,
                }),
                Effect.as<RequestIntentReading>({ intent: null, source: "unread" }),
              ),
            ),
          );
        yield* conversations
          .setTurnIntent(turn.id, reading)
          .pipe(Effect.catchTag("AgentTurnNotFoundError", () => Effect.void));
        return reading;
      });

    /** What the worktree holds against its base and against the change's last landing. */
    const changeOf = (session: Session) =>
      Effect.gen(function* () {
        const worktree = yield* worktrees.byId(session.worktreeId);
        const change = yield* changes.byWorktree(worktree.id);
        const empty: ChangeFacts = { captured: true, empty: true, newSinceLanding: false };
        if (change === null) return empty;
        const sinceBase = yield* reads.changedFiles(
          session.projectId,
          worktree.id,
          worktree.baseSha,
        );
        if (sinceBase.value.length === 0) return empty;
        const lastPush = (yield* landings.listForChange(change.id)).find(
          (landed) => landed.pushedSha !== null,
        );
        const landedAt = lastPush?.checkpointSha ?? lastPush?.pushedSha ?? null;
        if (landedAt === null) {
          return { captured: true, empty: false, newSinceLanding: true } satisfies ChangeFacts;
        }
        const sinceLanding = yield* reads.changedFiles(session.projectId, worktree.id, landedAt);
        return {
          captured: true,
          empty: false,
          newSinceLanding: sinceLanding.value.length > 0,
        } satisfies ChangeFacts;
      });

    /**
     * Bring the registered captures up to the turn before the change is read for a landing: ask
     * the executor to flush, and again after a pause while it answers incomplete. False when it
     * never caught up.
     */
    const caughtUp = (session: Session, turn: AgentTurn) =>
      Effect.gen(function* () {
        for (let attempt = 1; attempt <= flushAttempts; attempt += 1) {
          const observed = yield* engine
            .flushCaptures(session.id, `automatic landing · turn ${turn.ordinal}`)
            .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed("none" as const)));
          if (observed !== "incomplete") return true;
          yield* Effect.logInfo("automatic landing: the captures have not caught up").pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              turnId: turn.id,
              attempt,
              attempts: flushAttempts,
            }),
          );
          if (attempt < flushAttempts) yield* Effect.sleep(flushPause);
        }
        return false;
      });

    /** The change for a landing: read only once the captures caught up with the turn. */
    const capturedChangeOf = (session: Session, turn: AgentTurn) =>
      Effect.gen(function* () {
        if (!(yield* caughtUp(session, turn))) return NOT_CAPTURED;
        return yield* changeOf(session).pipe(
          // The chain has no head at all: nothing Mend can read is the change yet.
          Effect.catchTag("WorktreeNotCapturedError", () => Effect.succeed(NOT_CAPTURED)),
        );
      });

    /**
     * Nothing new since the last landing: said, unless that landing was made during the turn
     * (`mend land`, the button), which already answered it.
     */
    const nothingNew = (session: Session, turn: AgentTurn) =>
      Effect.gen(function* () {
        const change = yield* changes.byWorktree(session.worktreeId);
        const since = turn.startedAt ?? turn.createdAt;
        const landedDuringTurn =
          change !== null &&
          (yield* landings.listForChange(change.id)).some((landed) => landed.createdAt >= since);
        return landedDuringTurn ? skippedFor("landed during the turn") : notLanded("nothing-new");
      });

    /**
     * Land the change as its owner, with the owner's credentials, and audit it. A request to land
     * is the owner's own landing (`manual`); otherwise it is `automatic`. A landing that did not
     * start says why, unless a landing made during the turn (`mend land`) already answered it.
     */
    const land = (
      session: Session,
      project: Project,
      owner: string,
      turn: AgentTurn,
      requested: boolean,
    ) =>
      Effect.gen(function* () {
        const install = yield* installOf(session);
        const started = yield* lander
          .land({
            session,
            project,
            ownerUserId: owner,
            trigger: requested ? "manual" : "automatic",
            webOrigin: install?.webOrigin ?? network.appUrl,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(started)) return attempted(started.success.landing.id);
        const refusal = started.failure;
        switch (refusal.reason) {
          case "nothing-new":
            return yield* nothingNew(session, turn);
          case "no-change":
            return notLanded("no-change");
          case "no-owner":
          case "not-owner":
            return notLanded("not-owner");
          case "not-found":
          case "branch":
            return skippedFor(refusal.message);
        }
      });

    /** The checks, in the ADR's order, for one ended turn this worker claimed. */
    const decide = Effect.fn("AutomaticLanding.decide")(function* (
      session: Session,
      turn: AgentTurn,
      turns: ReadonlyArray<AgentTurn>,
    ) {
      if (now() - (turn.endedAt ?? turn.createdAt).getTime() > TURN_FRESHNESS_MS) {
        return skippedFor("ended long ago");
      }
      const project = yield* projects.byId(session.projectId);
      // The change's owner, who lands it: never a teammate who joined the worktree.
      const owner = changeOwnerOf(yield* sessions.listForWorktree(session.worktreeId));
      const plan = planTurn({
        turn,
        changeOwnerUserId: owner,
        sessionOwnerUserId: session.ownerUserId,
        origin: session.origin,
        on: yield* landsOn(session, project),
        pending: yield* conversations.hasPendingRequests(session.id),
        later: turns.some((other) => other.ordinal > turn.ordinal),
      });
      if (plan._tag === "skipped") return skippedFor(plan.why);
      // A reason that holds the change back is stated only when there is something to land.
      if (plan._tag === "not-landed")
        return decidedAs(heldBack(plan.reason, yield* changeOf(session)));
      if (owner === null) return skippedFor("no owner");
      const step = afterTheIntent(yield* intentOf(session, turn, turns), plan.on);
      if (step._tag === "not-landed") {
        return decidedAs(heldBack(step.reason, yield* changeOf(session)));
      }
      const change = yield* capturedChangeOf(session, turn);
      // The wait for the captures can outlast the next request: its end decides instead.
      const since = yield* conversations.listTurns(session.id);
      if (since.some((other) => other.ordinal > turn.ordinal)) {
        return skippedFor("a later turn decides");
      }
      const decision = withTheChange(step, change);
      if (decision._tag === "not-landed" && decision.reason === "nothing-new") {
        return yield* nothingNew(session, turn);
      }
      if (decision._tag !== "land") return decidedAs(decision);
      return yield* land(session, project, owner, turn, decision.requested);
    });

    /** A change that could not be read is not landed, and says nothing. */
    const unreadable = (sessionId: SessionId, turn: AgentTurn, cause: string) =>
      Effect.logWarning("automatic landing: the change could not be read").pipe(
        Effect.annotateLogs({ sessionId, turnId: turn.id, cause }),
        Effect.as(skippedFor(`the change could not be read · ${cause}`)),
      );

    /** Decide every ended turn of the session nobody has decided yet. */
    const consider = Effect.fn("AutomaticLanding.consider")(function* (sessionId: SessionId) {
      const turns = yield* conversations.listTurns(sessionId);
      const open = turns
        .filter((turn) => ended(turn) && turn.landing === null)
        .toSorted((a, b) => a.ordinal - b.ordinal);
      if (open.length === 0) return;
      const session = yield* sessions
        .byId(sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null) return;
      for (const candidate of open) {
        const turn = yield* conversations.claimTurnLanding(candidate.id);
        if (turn === null) continue; // another worker has it, or it moved
        const decision = yield* decide(session, turn, turns).pipe(
          Effect.catchTags({
            ProjectNotFoundError: () => Effect.succeed(skippedFor("the project is gone")),
            WorktreeNotFoundError: () => Effect.succeed(skippedFor("the worktree is gone")),
            GitError: (error) => unreadable(sessionId, turn, error._tag),
            WorktreeNotCapturedError: (error) => unreadable(sessionId, turn, error._tag),
          }),
        );
        // Every decision is on the record and in the log, landed or not, with its reason.
        yield* Effect.logInfo(`automatic landing: ${decision.landing} · ${decision.why}`).pipe(
          Effect.annotateLogs({
            sessionId,
            turnId: turn.id,
            ordinal: turn.ordinal,
            landing: decision.landing,
            landingId: decision.landingId,
            why: decision.why,
          }),
        );
        yield* conversations
          .decideTurnLanding(turn.id, decision.landing, decision.landingId)
          .pipe(Effect.catchTag("AgentTurnNotFoundError", () => Effect.void));
      }
    });

    /** Every session that may have ended a turn while nobody was listening. */
    const sweep = Effect.fn("AutomaticLanding.sweep")(function* () {
      for (const session of yield* sessions.listActive()) {
        yield* consider(session.id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automatic landing: session look failed").pipe(
              Effect.annotateLogs({ sessionId: session.id, cause: Cause.pretty(cause) }),
            ),
          ),
        );
      }
    });

    return { consider, sweep };
  });

export const AutomaticLandingLive: Layer.Layer<
  never,
  never,
  | PgClient.PgClient
  | AgentConversationRepo
  | ChangeLandingsRepo
  | NetworkConfig
  | OwnerLanding
  | ProjectsRepo
  | RequestIntentReader
  | SessionEngine
  | SessionsRepo
  | SettingsRepo
  | SlackInstallsRepo
  | SlackThreadsRepo
  | WorktreeChangesRepo
  | WorktreeReads
  | WorktreesRepo
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const lander = yield* makeAutomaticLanding();

    const scope = yield* Effect.scope;
    // Each session is looked at on its own fiber, so one waiting on its executor's captures holds
    // up no other session. A burst of events for one session (every streamed item notifies) is
    // one look: an event during a look asks for one more once it ends.
    const looking = new Set<string>();
    const again = new Set<string>();
    const look = (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (looking.has(sessionId)) {
          again.add(sessionId);
          return Effect.void;
        }
        looking.add(sessionId);
        return lander.consider(SessionId.make(sessionId)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automatic landing: session look failed").pipe(
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
    yield* Effect.forkScoped(lander.sweep());

    yield* sql.listen(MEND_EVENTS_CHANNEL).pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) =>
            event.type === "agent-conversation" ? look(event.sessionId) : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("automatic landing: event handling failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("automatic landing: listen stream ended").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
