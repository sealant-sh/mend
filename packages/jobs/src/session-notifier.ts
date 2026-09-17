import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  MEND_EVENTS_CHANNEL,
  MendEvent,
  ProjectsRepo,
  PushDevicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import { AgentTurnId, SessionId } from "@mend/domain";
import {
  agentProcessOutcome,
  currentAgentProcess,
  type AgentTurn,
  type Session,
  type SessionProcess,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema, Stream } from "effect";

import { notificationRecipients } from "./notification-recipients.ts";

/**
 * Pushes a notification to registered phones when a session needs the user:
 * it settled (completed · failed), is waiting for input, or a protocol turn
 * finished while the agent process stays alive (session status keeps reading
 * `running` between turns, so the settle path never sees it). The suppression
 * discipline is ported from t3code (MIT — pingdotgg/t3code relay), which
 * exists because every guard here is a bug they shipped without:
 *
 * - phase, not status: `waiting`/`idle` collapse to one "attention" phase so
 *   flapping between them can't re-ring; `starting`/`running`/`stopped` never
 *   notify (stopped is the user's own hand).
 * - known baseline only: a session or turn first seen mid-flight records its
 *   state silently — reconnecting or restarting the server must not buzz the
 *   phone. A turn rings only if this process saw it open first.
 * - freshness: a terminal state older than two minutes is history, not news.
 */

type Phase = "attention" | "completed" | "failed";

const TERMINAL_FRESHNESS_MS = 2 * 60_000;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BODY_LIMIT = 140;

/**
 * The phase of a session as the phone should hear it. Session status is a fold over EVERY
 * process (docs/SESSION-SERVICES.md): a session whose agent ended while a shell still holds the
 * workspace reads `idle`, so the agent's own outcome comes from its process row. `waiting` is the
 * only attention phase (a protocol-mode agent asking for input); `idle` by itself is nobody's
 * problem — it means no agent is running.
 */
export const phaseOf = (status: string, currentAgent: SessionProcess | null): Phase | null => {
  switch (status) {
    case "waiting":
      return "attention";
    case "idle": {
      const outcome = currentAgent === null ? null : agentProcessOutcome(currentAgent);
      return outcome === "completed" || outcome === "failed" ? outcome : null;
    }
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
};

const clip = (text: string): string =>
  text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text;

export const notificationBody = (session: Session, phase: Phase): string => {
  const name = session.label ?? session.harness;
  if (phase === "attention") return `${name} is waiting on you`;
  const summary =
    session.summary === null || session.summary === "" ? "" : `: ${clip(session.summary)}`;
  return phase === "completed" ? `${name} completed${summary}` : `${name} failed${summary}`;
};

/** A protocol turn ended while the agent stays live: name the prompt it answered. */
export const turnNotificationBody = (session: Session, turn: AgentTurn): string => {
  const name = session.label ?? session.harness;
  const prompt = turn.input.trim() === "" ? "" : ` · ${clip(turn.input.trim())}`;
  return turn.status === "completed"
    ? `${name} answered${prompt}`
    : `${name} hit an error${prompt}`;
};

interface ExpoPushTicket {
  readonly status: string;
  readonly details?: { readonly error?: string };
}

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

export const SessionNotifierLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const projects = yield* ProjectsRepo;
    const devices = yield* PushDevicesRepo;
    const conversations = yield* AgentConversationRepo;

    const lastPhase = new Map<string, Phase | null>();
    /** Per session: the open (queued/running) turn ids seen on the last event. */
    const watchedTurns = new Map<string, ReadonlySet<string>>();

    const send = Effect.fn("SessionNotifier.send")(function* (session: Session, body: string) {
      // The owner's phones only (docs/adr/0003); shared control will add the latest sender.
      const recipients = notificationRecipients({
        ownerUserId: session.ownerUserId,
        sharedControl: false,
        latestTurnSenderUserId: null,
      });
      const targets = yield* devices.listForUsers([...recipients]);
      if (targets.length === 0) return;
      const title = yield* projects.byId(session.projectId).pipe(
        Effect.map((project) => project.name),
        Effect.orElseSucceed(() => session.harness),
      );
      const messages = targets.map((device) => ({
        to: device.token,
        title,
        body,
        data: { sessionId: session.id, projectId: session.projectId },
        sound: "default",
      }));
      const tickets = yield* Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<ExpoPushTicket>> => {
          const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(messages),
          });
          if (!response.ok) throw new Error(`expo push → ${response.status}`);
          const parsed = (await response.json()) as { data?: ReadonlyArray<ExpoPushTicket> };
          return parsed.data ?? [];
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      // Tickets align with the request order; a dead token is pruned, not retried.
      yield* Effect.forEach(
        tickets.flatMap((ticket, index) =>
          ticket.details?.error === "DeviceNotRegistered" && targets[index] !== undefined
            ? [targets[index].token]
            : [],
        ),
        (token) => devices.remove(token),
      );
    });

    const observe = Effect.fn("SessionNotifier.observe")(function* (sessionId: string) {
      const session = yield* sessions.byId(SessionId.make(sessionId));
      const currentAgent = currentAgentProcess(yield* processes.listForSession(session.id));
      const phase = phaseOf(session.status, currentAgent);
      const previous = lastPhase.get(session.id);
      lastPhase.set(session.id, phase);
      if (previous === undefined) return; // unknown baseline — record, never ring
      if (previous === phase || phase === null) return;
      if (phase !== "attention") {
        const endedAt =
          session.settledAt?.getTime() ?? currentAgent?.exitedAt?.getTime() ?? Date.now();
        if (Date.now() - endedAt > TERMINAL_FRESHNESS_MS) return;
      }
      yield* send(session, notificationBody(session, phase));
    });

    const ringForTurn = Effect.fn("SessionNotifier.ringForTurn")(function* (
      sessionId: string,
      turn: AgentTurn,
    ) {
      // Interrupted/cancelled is the user's own hand; stale ends are history.
      if (turn.status !== "completed" && turn.status !== "failed") return;
      const endedAt = turn.endedAt?.getTime() ?? Date.now();
      if (Date.now() - endedAt > TERMINAL_FRESHNESS_MS) return;
      const session = yield* sessions.byId(SessionId.make(sessionId));
      // A settling or waiting session rings through the phase path above.
      if (session.status !== "running" && session.status !== "idle") return;
      yield* send(session, turnNotificationBody(session, turn));
    });

    // Diff the open-turn set: whatever left it since the last event ended, and
    // rings if its final status warrants. Ring only for turns this process
    // watched open — a turn first seen finished is replay, not news.
    const observeTurn = Effect.fn("SessionNotifier.observeTurn")(function* (sessionId: string) {
      const open = yield* conversations.openTurns(SessionId.make(sessionId));
      const openIds = new Set<string>(open.map((turn) => turn.id));
      const previous = watchedTurns.get(sessionId);
      watchedTurns.set(sessionId, openIds);
      if (previous === undefined) return; // unknown baseline — record, never ring
      for (const turnId of previous) {
        if (openIds.has(turnId)) continue;
        const ended = yield* conversations.byTurnId(AgentTurnId.make(turnId));
        if (ended !== null) yield* ringForTurn(sessionId, ended);
      }
    });

    // Baseline: whatever is live right now was live before we were listening.
    const active = yield* sessions.listActive();
    for (const session of active) {
      const currentAgent = currentAgentProcess(yield* processes.listForSession(session.id));
      lastPhase.set(session.id, phaseOf(session.status, currentAgent));
    }

    yield* sql.listen(MEND_EVENTS_CHANNEL).pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) => {
            if (event.type === "session") return observe(event.sessionId);
            if (event.type === "agent-conversation") return observeTurn(event.sessionId);
            return Effect.void;
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("session notifier: event handling failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("session notifier: listen stream ended").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
