import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  AuditEventsRepo,
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
  type Project,
  type RequestIntentReading,
  requestOfTurn,
  resolveAutoLand,
  type Session,
  type TurnLanding,
} from "@mend/domain/workbench";
import { RequestIntentReader } from "@mend/inference";
import { afterTheIntent, beforeTheChange, Landing, recordedIntent } from "@mend/landing";
import { NetworkConfig } from "@mend/network";
import { asSealantUser } from "@mend/sealant";
import { WorktreeReads } from "@mend/sessions";
import { AgentBridge, MendKeys, SourcePolicy } from "@mend/store";
import { Cause, Effect, Layer, Queue, Schema, Stream } from "effect";

import { ProjectAccess } from "./access.ts";
import { auditLanding, remoteEnvFor } from "./landing-state.ts";
import { withSignerContext } from "./routes/workbench.ts";

/**
 * Automatic landing (docs/adr/0007-landing.md, "Automatic landing"): after each turn that
 * completes, Mend lands the change when automatic landing is on for the session and the turn
 * passes the ADR's five checks, in order (`beforeTheChange`, then the change, then
 * `afterTheIntent`). The first landing opens the pull request; later ones update it.
 *
 * It listens on `mend_events` beside the notifier and the Slack reporter, and looks again at a
 * session whenever its conversation moves. Each ended turn is decided once: a worker claims the
 * turn in Postgres (`claimTurnLanding`) before it reads anything, so a second worker, or a second
 * look, never lands it twice. The decision is recorded on the turn: `attempted` with the landing
 * it started, a reason it did not land, or `skipped`.
 *
 * Nothing retries. A landing that is refused or fails is recorded as such, and the next
 * completed turn, or the owner's button, is the next attempt.
 */

/** A turn that ended longer ago than this is history: decided `skipped`, never landed. */
const TURN_FRESHNESS_MS = 15 * 60_000;
/** How many earlier requests the intent reading sees as context. */
const CONTEXT_TURNS = 5;

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

interface Decided {
  readonly landing: TurnLanding;
  readonly landingId: ChangeLandingId | null;
}

const decided = (landing: TurnLanding, landingId: ChangeLandingId | null = null): Decided => ({
  landing,
  landingId,
});

const SKIPPED = decided("skipped");

const ended = (turn: AgentTurn): boolean => turn.status !== "queued" && turn.status !== "running";

export interface AutomaticLandingOptions {
  readonly now?: () => number;
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
    const landing = yield* Landing;
    const network = yield* NetworkConfig;
    // What the landing's push and audit read, captured once so a look needs nothing more.
    const context = yield* Effect.context<
      AuditEventsRepo | ProjectAccess | SourcePolicy | MendKeys | AgentBridge
    >();
    const now = options.now ?? Date.now;

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
        const settings = yield* settingsRepo.get();
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
     * small call as the owner, recorded on the turn. Unreadable reads as not read.
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
            asSealantUser(session.ownerUserId),
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

    /** Whether the worktree holds work that is not on origin yet: not empty, not already landed. */
    const holdsNewWork = (session: Session) =>
      Effect.gen(function* () {
        const worktree = yield* worktrees.byId(session.worktreeId);
        const change = yield* changes.byWorktree(worktree.id);
        if (change === null) return false;
        const sinceBase = yield* reads.changedFiles(
          session.projectId,
          worktree.id,
          worktree.baseSha,
        );
        if (sinceBase.value.length === 0) return false;
        const lastPush = (yield* landings.listForChange(change.id)).find(
          (landed) => landed.pushedSha !== null,
        );
        const landedAt = lastPush?.checkpointSha ?? lastPush?.pushedSha ?? null;
        if (landedAt === null) return true;
        const sinceLanding = yield* reads.changedFiles(session.projectId, worktree.id, landedAt);
        return sinceLanding.value.length > 0;
      });

    /** Land the change as its owner, with the owner's credentials, and audit it. */
    const land = (session: Session, project: Project, owner: string) =>
      Effect.gen(function* () {
        const remoteEnv = yield* remoteEnvFor(project, owner, "push");
        const install = yield* installOf(session);
        const report = yield* withSignerContext(
          project.gitAuthMode,
          owner,
          `land ${session.label ?? session.id} → origin`,
          landing.land({
            sessionId: session.id,
            actorUserId: owner,
            trigger: "automatic",
            remoteBranch: null,
            pullRequest: true,
            title: null,
            body: null,
            webOrigin: install?.webOrigin ?? network.appUrl,
            remoteEnv,
          }),
        ).pipe(asSealantUser(owner));
        yield* auditLanding(report.landing, project.organizationId, owner);
        return decided("attempted", report.landing.id);
      }).pipe(Effect.provide(context));

    /** The checks, in the ADR's order, for one ended turn this worker claimed. */
    const decide = Effect.fn("AutomaticLanding.decide")(function* (
      session: Session,
      turn: AgentTurn,
      turns: ReadonlyArray<AgentTurn>,
    ) {
      if (now() - (turn.endedAt ?? turn.createdAt).getTime() > TURN_FRESHNESS_MS) return SKIPPED;
      const project = yield* projects.byId(session.projectId);
      const opening = turns.every((other) => other.ordinal >= turn.ordinal);
      const step = beforeTheChange({
        turn,
        ownerUserId: session.ownerUserId,
        origin: session.origin,
        on: yield* landsOn(session, project),
        pending: yield* conversations.hasPendingRequests(session.id),
        later: turns.some((other) => other.ordinal > turn.ordinal),
        opening,
      });
      if (step._tag === "skipped") return SKIPPED;
      // A turn that touched nothing, or left what already landed, says nothing about landing.
      if (!(yield* holdsNewWork(session))) return SKIPPED;
      if (step.next !== "read-intent") return decided(step.next);
      const owner = session.ownerUserId;
      if (owner === null) return SKIPPED;
      const reading = yield* intentOf(session, turn, turns);
      const next = afterTheIntent(reading);
      if (next._tag === "not-landed") return decided(next.reason);
      return yield* land(session, project, owner);
    });

    /** A change that could not be read is not landed, and says nothing. */
    const unreadable = (sessionId: SessionId, turn: AgentTurn, cause: string) =>
      Effect.logWarning("automatic landing: the change could not be read").pipe(
        Effect.annotateLogs({ sessionId, turnId: turn.id, cause }),
        Effect.as(SKIPPED),
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
            ProjectNotFoundError: () => Effect.succeed(SKIPPED),
            WorktreeNotFoundError: () => Effect.succeed(SKIPPED),
            GitError: (error) => unreadable(sessionId, turn, error._tag),
            WorktreeNotCapturedError: (error) => unreadable(sessionId, turn, error._tag),
            LandingNotStartedError: (error) =>
              Effect.logInfo("automatic landing: not started").pipe(
                Effect.annotateLogs({ sessionId, turnId: turn.id, reason: error.reason }),
                Effect.as(SKIPPED),
              ),
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
  | AgentBridge
  | AgentConversationRepo
  | AuditEventsRepo
  | ChangeLandingsRepo
  | Landing
  | MendKeys
  | NetworkConfig
  | ProjectAccess
  | ProjectsRepo
  | RequestIntentReader
  | SessionsRepo
  | SettingsRepo
  | SlackInstallsRepo
  | SlackThreadsRepo
  | SourcePolicy
  | WorktreeChangesRepo
  | WorktreeReads
  | WorktreesRepo
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const lander = yield* makeAutomaticLanding();

    // A burst of events for one session (every streamed item notifies) is one look, as in the
    // Slack reporter: queued once until the look starts, and again by events during it.
    const queued = new Set<string>();
    const work = yield* Queue.unbounded<string>();
    yield* Effect.gen(function* () {
      yield* lander.sweep();
      while (true) {
        const sessionId = yield* Queue.take(work);
        queued.delete(sessionId);
        yield* lander
          .consider(SessionId.make(sessionId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("automatic landing: session look failed").pipe(
                Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
              ),
            ),
          );
      }
    }).pipe(Effect.forkScoped);

    yield* sql.listen(MEND_EVENTS_CHANNEL).pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) => {
            if (event.type !== "agent-conversation" || queued.has(event.sessionId)) {
              return Effect.void;
            }
            queued.add(event.sessionId);
            return Queue.offer(work, event.sessionId);
          }),
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
