import {
  AgentConversationRepo,
  ScreensRepo,
  ServicesRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import type { SessionId } from "@mend/domain";
import {
  currentAgentProcess,
  DEFAULT_PROTOCOL_IDLE_STOP_MINUTES,
  idleStopSummary,
  isLiveProcess,
  isWakeShell,
  protocolIdleReading,
  protocolIdleStopDue,
  screenHeldByPerson,
  screenIdleStopDue,
  type Session,
  type SessionProcess,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { Clock, Config, Duration, Effect, Layer, Schedule } from "effect";
import * as Context from "effect/Context";

/**
 * The idle stop (docs/SELF-HOSTING.md, "Idle agents"). A protocol agent (a Slack-started session,
 * a conversation on the web or the phone) stays up between turns, waiting for the next one, and
 * keeps its workspace up with it; only the platform's cap on a workspace ever ended one. Every
 * minute this pass stops each protocol agent that has sat idle past
 * MEND_PROTOCOL_IDLE_STOP_MINUTES (`protocolIdleReading`), the way the Stop button does. The
 * session reads `idle · stopped after 15 min · reply to resume`, its control log records an
 * `idle-stop` by its owner, and the next message resumes it. In capture mode an executor still
 * shipping captures holds the stop (`capture`), and the stop itself drains before the workspace
 * goes, as every stop does. A person holding a session's screen holds its stop (`screen`), and the
 * same pass stops each screen idle past its own limit (ADR 0020, D7), whatever the minutes say.
 */
export class ProtocolIdleStop extends Context.Service<
  ProtocolIdleStop,
  {
    /** One pass over the unsettled sessions; answers the ones this caller stopped. */
    readonly sweep: () => Effect.Effect<ReadonlyArray<SessionId>>;
  }
>()("@mend/jobs/ProtocolIdleStop") {}

/** How often the pass runs. */
export const PROTOCOL_IDLE_SWEEP_INTERVAL = Duration.seconds(60);

/** A claim this old whose session is still unsettled is a stop that never landed: take it again. */
export const IDLE_STOP_CLAIM_RETRY = Duration.minutes(10);

/** Minutes of idleness before the stop; 0 turns it off. */
export const protocolIdleStopMinutes = Config.Int("MEND_PROTOCOL_IDLE_STOP_MINUTES").pipe(
  Config.withDefault(DEFAULT_PROTOCOL_IDLE_STOP_MINUTES),
);

/** The live protocol agent, or a wake shell when no agent runs in the workspace. */
const liveProtocolAgent = (rows: ReadonlyArray<SessionProcess>): SessionProcess | null => {
  const agent = currentAgentProcess(rows);
  if (agent !== null && isLiveProcess(agent)) return agent.kind === "agent-protocol" ? agent : null;
  return rows.find((row) => isWakeShell(row) && isLiveProcess(row)) ?? null;
};

const screenLive = (rows: ReadonlyArray<SessionProcess>): boolean =>
  rows.some((row) => row.kind === "screen" && isLiveProcess(row));

export const ProtocolIdleStopLive: Layer.Layer<
  ProtocolIdleStop,
  Config.ConfigError,
  | AgentConversationRepo
  | ScreensRepo
  | ServicesRepo
  | SessionControlEventsRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionsRepo
> = Layer.effect(
  ProtocolIdleStop,
  Effect.gen(function* () {
    const minutes = yield* protocolIdleStopMinutes;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const conversations = yield* AgentConversationRepo;
    const services = yield* ServicesRepo;
    const screens = yield* ScreensRepo;
    const controlEvents = yield* SessionControlEventsRepo;
    const engine = yield* SessionEngine;
    const summary = idleStopSummary(minutes);

    /** Stop one session when it is due, once across workers. True when this caller stopped it. */
    const stopIfIdle = Effect.fn("ProtocolIdleStop.stopIfIdle")(function* (
      session: Session,
      rows: ReadonlyArray<SessionProcess>,
      agent: SessionProcess,
      liveServices: number,
      nowMs: number,
    ) {
      const screen = screenLive(rows) ? yield* screens.ofSession(session.id) : null;
      const facts = {
        session,
        processes: rows,
        turns: yield* conversations.listTurns(session.id),
        requests: yield* conversations.listRequests(session.id, false),
        liveServices,
        tasks: isWakeShell(agent)
          ? { running: 0, lastUpdatedAt: null }
          : yield* conversations.taskActivity(agent.id),
        screenHeld: screen !== null && screenHeldByPerson(screen.input),
      };
      if (!protocolIdleStopDue(protocolIdleReading(facts), nowMs, minutes)) return false;
      // Capture mode: an executor with captures still to ship is not idle — a stop now would only
      // sit draining them (docs/adr/0002, "Stop drains, then terminates"). Asked only of a session
      // otherwise due, so an idle pass flushes nobody else.
      const captures = yield* engine
        .readCaptures(session.id)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      const reading = protocolIdleReading({
        ...facts,
        capture:
          captures === null
            ? null
            : {
                pending: captures.pending,
                bulkDirty: captures.bulkDirty,
                overdue: (captures.overdue ?? null) !== null,
              },
      });
      if (!protocolIdleStopDue(reading, nowMs, minutes)) {
        if (reading.kind === "held" && reading.by === "capture") {
          yield* Effect.logInfo(
            "protocol idle stop: held · captures still shipping, or a capture step overdue",
          ).pipe(
            Effect.annotateLogs({
              sessionId: session.id,
              pending: captures?.pending ?? null,
              overdue: captures?.overdue?.step ?? null,
            }),
          );
        }
        return false;
      }
      const retryBefore = new Date(nowMs - Duration.toMillis(IDLE_STOP_CLAIM_RETRY));
      if (!(yield* sessions.claimIdleStop(session.id, retryBefore))) return false;
      const stopped = yield* engine.stop(session.id, summary).pipe(Effect.exit);
      if (stopped._tag === "Failure") {
        yield* sessions.releaseIdleStop(session.id);
        yield* Effect.logWarning("protocol idle stop: the stop failed").pipe(
          Effect.annotateLogs({ sessionId: session.id, cause: String(stopped.cause) }),
        );
        return false;
      }
      // The control log's actor is an account: the owner, whose agent it was.
      if (session.ownerUserId !== null) {
        yield* controlEvents.record({
          sessionId: session.id,
          actorUserId: session.ownerUserId,
          kind: "idle-stop",
          refId: agent.id,
        });
      }
      yield* Effect.logInfo("protocol idle stop: stopped an idle agent").pipe(
        Effect.annotateLogs({
          sessionId: session.id,
          processId: agent.id,
          idleSince: reading.kind === "idle" ? reading.since.toISOString() : null,
          minutes,
        }),
      );
      return true;
    });

    const stopScreenIfIdle = Effect.fn("ProtocolIdleStop.stopScreenIfIdle")(function* (
      session: Session,
      nowMs: number,
    ) {
      const screen = yield* screens.ofSession(session.id);
      const lastActivity = screen === null ? null : yield* screens.lastActivityAt(screen.id);
      if (screen === null || lastActivity === null) return;
      if (!screenIdleStopDue(screen, lastActivity, nowMs)) return;
      yield* engine.stopScreen(session.id, "idle");
      yield* Effect.logInfo("protocol idle stop: stopped an idle screen").pipe(
        Effect.annotateLogs({ sessionId: session.id, idleSince: lastActivity.toISOString() }),
      );
    });

    const sweep = Effect.fn("ProtocolIdleStop.sweep")(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const candidates: Array<{
        readonly session: Session;
        readonly rows: ReadonlyArray<SessionProcess>;
        readonly agent: SessionProcess;
      }> = [];
      for (const session of yield* sessions.listUnsettled()) {
        const rows = yield* processes.listForSession(session.id);
        if (screenLive(rows)) {
          yield* stopScreenIfIdle(session, nowMs).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("protocol idle stop: a screen was not read").pipe(
                Effect.annotateLogs({ sessionId: session.id, cause: String(cause) }),
              ),
            ),
          );
        }
        const agent = liveProtocolAgent(rows);
        if (agent !== null) candidates.push({ session, rows, agent });
      }
      if (minutes <= 0 || candidates.length === 0) return [];
      const liveCounts = yield* services.liveCountsForSessions(
        candidates.map((candidate) => candidate.session.id),
      );
      const stopped: Array<SessionId> = [];
      for (const { session, rows, agent } of candidates) {
        const done = yield* stopIfIdle(
          session,
          rows,
          agent,
          liveCounts.get(session.id) ?? 0,
          nowMs,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("protocol idle stop: a session was not read").pipe(
              Effect.annotateLogs({ sessionId: session.id, cause: String(cause) }),
              Effect.as(false),
            ),
          ),
        );
        if (done) stopped.push(session.id);
      }
      return stopped;
    });

    return { sweep };
  }),
);

/** The minute's pass, in every worker; the claim keeps each stop to one of them. */
export const ProtocolIdleStopScheduleLive: Layer.Layer<never, never, ProtocolIdleStop> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const idle = yield* ProtocolIdleStop;
      yield* Effect.forkScoped(
        idle.sweep().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("protocol idle stop: pass failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(PROTOCOL_IDLE_SWEEP_INTERVAL)),
        ),
      );
    }),
  );
