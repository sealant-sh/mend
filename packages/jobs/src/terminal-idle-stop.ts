import {
  ScreensRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreesRepo,
} from "@mend/db";
import type { SessionId, SessionRuntime } from "@mend/domain";
import {
  currentAgentProcess,
  isLiveProcess,
  screenHeldByPerson,
  terminalIdleReading,
  terminalIdleStopDue,
  terminalIdleStopSummary,
  terminalProcesses,
  type Session,
  type SessionProcess,
} from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { Clock, Config, Duration, Effect, Layer, Schedule } from "effect";
import * as Context from "effect/Context";

import {
  IDLE_STOP_CLAIM_RETRY,
  PROTOCOL_IDLE_SWEEP_INTERVAL,
  protocolIdleStopMinutes,
} from "./protocol-idle-stop.ts";
import { makeTerminalOutput } from "./terminal-output.ts";

/**
 * The terminal idle stop on Boat (docs/SELF-HOSTING.md, "Idle agents"). On Boat every session is
 * its own paid machine. Every minute this pass stops each terminal session (a shell, `mend run`,
 * an agent in terminal mode) whose terminals have been quiet for MEND_PROTOCOL_IDLE_STOP_MINUTES
 * (`terminalIdleReading`): no client on them, nobody typing, nothing new printed. It stops it the
 * way the Stop button does, as the protocol idle stop does: the session reads
 * `idle · stopped after 15 min · resume to continue` (or the resume its harness takes), its control log records an `idle-stop` by
 * its owner, and resume brings it back. Captures still shipping and a person holding the screen
 * hold the stop. Containers, Services and background processes in the workspace hold nothing.
 * Sessions on Docker are never read here.
 */
export class TerminalIdleStop extends Context.Service<
  TerminalIdleStop,
  {
    /** One pass over the unsettled sessions; answers the ones this caller stopped. */
    readonly sweep: () => Effect.Effect<ReadonlyArray<SessionId>>;
  }
>()("@mend/jobs/TerminalIdleStop") {}

/** A session whose terminals the pass reads. */
interface Candidate {
  readonly session: Session;
  readonly rows: ReadonlyArray<SessionProcess>;
  readonly terminals: ReadonlyArray<SessionProcess>;
}

const screenLive = (rows: ReadonlyArray<SessionProcess>): boolean =>
  rows.some((row) => row.kind === "screen" && isLiveProcess(row));

/** Only terminals run: no protocol or external agent is live in the session. */
const terminalOnly = (rows: ReadonlyArray<SessionProcess>): ReadonlyArray<SessionProcess> => {
  const agent = currentAgentProcess(rows);
  if (agent !== null && isLiveProcess(agent) && agent.kind !== "agent-pty") return [];
  return terminalProcesses(rows);
};

export const TerminalIdleStopLive: Layer.Layer<
  TerminalIdleStop,
  Config.ConfigError,
  | ScreensRepo
  | SealantClient
  | SessionControlEventsRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionsRepo
  | WorktreesRepo
> = Layer.effect(
  TerminalIdleStop,
  Effect.gen(function* () {
    const minutes = yield* protocolIdleStopMinutes;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const worktrees = yield* WorktreesRepo;
    const screens = yield* ScreensRepo;
    const controlEvents = yield* SessionControlEventsRepo;
    const engine = yield* SessionEngine;
    const sealant = yield* SealantClient;
    const terminalOutput = makeTerminalOutput(sealant, "terminal idle stop");

    const runtimeOf = (session: Session) =>
      worktrees.byId(session.worktreeId).pipe(
        Effect.map((worktree): SessionRuntime | null => worktree.sessionRuntime),
        Effect.catchTag("WorktreeNotFoundError", () => Effect.succeed(null)),
      );

    /** Stop one session when it is due, once across workers. True when this caller stopped it. */
    const stopIfIdle = Effect.fn("TerminalIdleStop.stopIfIdle")(function* (
      { session, rows, terminals }: Candidate,
      terminalActiveAt: Date | null,
      nowMs: number,
    ) {
      const output = yield* terminalOutput.outputOf(session, terminals, new Date(nowMs));
      const screen = screenLive(rows) ? yield* screens.ofSession(session.id) : null;
      const facts = {
        session,
        runtime: "boat" as const,
        processes: rows,
        terminalActiveAt,
        output,
        screenHeld: screen !== null && screenHeldByPerson(screen.input),
      };
      if (!terminalIdleStopDue(terminalIdleReading(facts), nowMs, minutes)) return false;
      // Capture mode: an executor with captures still to ship holds the stop, as it holds the
      // protocol idle stop. Asked only of a session otherwise due.
      const captures = yield* engine
        .readCaptures(session.id)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      const reading = terminalIdleReading({
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
      if (!terminalIdleStopDue(reading, nowMs, minutes)) {
        if (reading.kind === "held" && reading.by === "capture") {
          yield* Effect.logInfo(
            "terminal idle stop: held · captures still shipping, or a capture step overdue",
          ).pipe(
            Effect.annotateLogs({ sessionId: session.id, pending: captures?.pending ?? null }),
          );
        }
        return false;
      }
      const retryBefore = new Date(nowMs - Duration.toMillis(IDLE_STOP_CLAIM_RETRY));
      if (!(yield* sessions.claimIdleStop(session.id, retryBefore))) return false;
      const stopped = yield* engine
        .stop(session.id, terminalIdleStopSummary(minutes, session.harness))
        .pipe(Effect.exit);
      if (stopped._tag === "Failure") {
        yield* sessions.releaseIdleStop(session.id);
        yield* Effect.logWarning("terminal idle stop: the stop failed").pipe(
          Effect.annotateLogs({ sessionId: session.id, cause: String(stopped.cause) }),
        );
        return false;
      }
      const terminal = currentAgentProcess(rows) ?? terminals[0] ?? null;
      if (session.ownerUserId !== null) {
        yield* controlEvents.record({
          sessionId: session.id,
          actorUserId: session.ownerUserId,
          kind: "idle-stop",
          refId: terminal?.id ?? null,
        });
      }
      yield* Effect.logInfo("terminal idle stop: stopped an idle terminal session").pipe(
        Effect.annotateLogs({
          sessionId: session.id,
          idleSince: reading.kind === "idle" ? reading.since.toISOString() : null,
          minutes,
        }),
      );
      return true;
    });

    const sweep = Effect.fn("TerminalIdleStop.sweep")(function* () {
      if (minutes <= 0) return [];
      const nowMs = yield* Clock.currentTimeMillis;
      const candidates: Array<Candidate> = [];
      for (const session of yield* sessions.listUnsettled()) {
        const rows = yield* processes.listForSession(session.id);
        const terminals = terminalOnly(rows);
        if (terminals.length === 0) continue;
        if ((yield* runtimeOf(session)) !== "boat") continue;
        candidates.push({ session, rows, terminals });
      }
      // A terminal that is no longer read keeps no mark.
      const read = new Set(candidates.flatMap(({ terminals }) => terminals.map(({ id }) => id)));
      terminalOutput.keepOnly(read);
      if (candidates.length === 0) return [];
      const activity = yield* sessions.terminalActivity(
        candidates.map((candidate) => candidate.session.id),
      );
      const stopped: Array<SessionId> = [];
      for (const candidate of candidates) {
        const done = yield* stopIfIdle(
          candidate,
          activity.get(candidate.session.id) ?? null,
          nowMs,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("terminal idle stop: a session was not read").pipe(
              Effect.annotateLogs({ sessionId: candidate.session.id, cause: String(cause) }),
              Effect.as(false),
            ),
          ),
        );
        if (done) stopped.push(candidate.session.id);
      }
      return stopped;
    });

    return { sweep };
  }),
);

/** The minute's pass, in every worker; the claim keeps each stop to one of them. */
export const TerminalIdleStopScheduleLive: Layer.Layer<never, never, TerminalIdleStop> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const idle = yield* TerminalIdleStop;
      yield* Effect.forkScoped(
        idle.sweep().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("terminal idle stop: pass failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(PROTOCOL_IDLE_SWEEP_INTERVAL)),
        ),
      );
    }),
  );
