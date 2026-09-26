import {
  AgentConversationRepo,
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
  protocolIdleReading,
  protocolIdleStopDue,
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
 * `idle-stop` by its owner, and the next message resumes it.
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
export const protocolIdleStopMinutes = Config.int("MEND_PROTOCOL_IDLE_STOP_MINUTES").pipe(
  Config.withDefault(DEFAULT_PROTOCOL_IDLE_STOP_MINUTES),
);

/** The live protocol agent a session's idle reading concerns, or null for any other session. */
const liveProtocolAgent = (rows: ReadonlyArray<SessionProcess>): SessionProcess | null => {
  const agent = currentAgentProcess(rows);
  return agent !== null && agent.kind === "agent-protocol" && isLiveProcess(agent) ? agent : null;
};

export const ProtocolIdleStopLive: Layer.Layer<
  ProtocolIdleStop,
  Config.ConfigError,
  | AgentConversationRepo
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
      const reading = protocolIdleReading({
        session,
        processes: rows,
        turns: yield* conversations.listTurns(session.id),
        requests: yield* conversations.listRequests(session.id, false),
        liveServices,
      });
      if (!protocolIdleStopDue(reading, nowMs, minutes)) return false;
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

    const sweep = Effect.fn("ProtocolIdleStop.sweep")(function* () {
      if (minutes <= 0) return [];
      const nowMs = yield* Clock.currentTimeMillis;
      const candidates: Array<{
        readonly session: Session;
        readonly rows: ReadonlyArray<SessionProcess>;
        readonly agent: SessionProcess;
      }> = [];
      for (const session of yield* sessions.listUnsettled()) {
        const rows = yield* processes.listForSession(session.id);
        const agent = liveProtocolAgent(rows);
        if (agent !== null) candidates.push({ session, rows, agent });
      }
      if (candidates.length === 0) return [];
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
