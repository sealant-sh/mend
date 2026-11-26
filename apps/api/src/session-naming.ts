import { AgentConversationRepo, ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import type { SessionId } from "@mend/domain";
import { requestOfTurn, resolveAutomation } from "@mend/domain/workbench";
import {
  type NameSessionJob,
  SessionNamer,
  type SessionNamingInput,
  withoutFirstPrompt,
} from "@mend/inference";
import { JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Cause, Effect } from "effect";

/** Harnesses whose native transcript the engine can parse for the first prompt. */
const NAMEABLE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * How many of the person's first messages the namer reads: past a first "hi" or "test" to the
 * message that says what the work is, without reading a long conversation.
 */
const OPENING_MESSAGES = 3;

/**
 * The first messages the session was sent, as Mend recorded them: the first turns Mend sent it,
 * without what Mend added (the landing guard). Empty for a session nobody sent a message through
 * Mend (a terminal session typed into), whose first prompts only its transcript holds.
 */
const openingMessagesFromRecord = Effect.fnUntraced(function* (sessionId: SessionId) {
  const inputs = yield* (yield* AgentConversationRepo).openingMessages(sessionId, OPENING_MESSAGES);
  return inputs.map((input) => requestOfTurn(input).trim()).filter((text) => text !== "");
});

/** Retryable by design: the job dies into its retry and reads the transcript again. */
const awaitTranscript = (why: string) => Effect.die(new Error(`${why} — retrying`));

/**
 * The first prompts from the harness's own transcript, with the agent's first reply: null once the
 * session settled without one. While it can still get one, the job dies into its retry until the
 * person types it.
 */
const openingMessagesFromTranscript = Effect.fnUntraced(function* (
  job: NameSessionJob,
  session: { readonly settledAt: Date | null },
) {
  const transcript = yield* (yield* SessionEngine)
    .transcript(job.sessionId)
    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
  const events = transcript?.events ?? [];
  const firstUserAt = events.findIndex((event) => event.kind === "user");
  const messages = events
    .flatMap((event) => (event.kind === "user" ? [event.text] : []))
    .slice(0, OPENING_MESSAGES);
  if (messages.length === 0) {
    // A settled session gets no first prompt any more: it stays unnamed, and the job ends
    // here instead of retrying for an hour into the dead letter.
    if (withoutFirstPrompt(session) === "leave-unnamed") return null;
    return yield* awaitTranscript("no first prompt in the transcript yet");
  }
  const reply = events
    .slice(firstUserAt + 1)
    .find((event): event is typeof event & { kind: "assistant" } => event.kind === "assistant");
  return { messages, ...(reply === undefined ? {} : { assistantReply: reply.text }) };
});

/**
 * The `name-session` job's pass. The first messages come from the job (a composed start's prompt),
 * else from Mend's own record of the messages sent (a session started bare, then sent a message
 * from a composer, the CLI or VS Code), else from the harness's transcript (a terminal session
 * typed into). Messages that don't say what the work is yet ("hi", or the model answering a
 * stand-in such as "placeholder", SLNT-1230) name nothing: the session stays unnamed until a later
 * message, which queues the namer again (`nameOnMessage`), or the transcript, which the job retries
 * on, says more. Every other no-name outcome is a quiet success: a renamed or deleted session, a
 * switched-off cascade, an unparseable harness on the transcript path.
 */
export const nameSession = Effect.fn("mend.session.name")(function* (job: NameSessionJob) {
  const sessions = yield* SessionsRepo;
  const session = yield* sessions
    .byId(job.sessionId)
    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
  if (session === null || session.label !== null) return;
  const inlinePrompt = job.firstUserTurn?.trim() ?? "";
  const seen =
    inlinePrompt === "" ? yield* openingMessagesFromRecord(job.sessionId) : [inlinePrompt];
  // The harness gate guards only transcript parsing: a prompt Mend saw names any harness,
  // opencode and shell included.
  const readsTranscript = NAMEABLE_HARNESSES.has(session.harness);
  if (seen.length === 0 && !readsTranscript) return;
  const project = yield* (yield* ProjectsRepo)
    .byId(session.projectId)
    .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
  if (project === null) return;
  // The project's choice, else the session owner's own, else their organization's.
  const settings = yield* (yield* SettingsRepo).forPerson(
    project.organizationId,
    session.ownerUserId,
  );
  if (!resolveAutomation(project.autoName, settings.autoName)) return;

  const namer = yield* SessionNamer;
  const named = (turns: Omit<SessionNamingInput, "harness" | "projectName">) =>
    namer.name({ harness: session.harness, projectName: project.name, ...turns });
  const write = Effect.fn("nameSession.write")(function* (label: string) {
    const wrote = yield* sessions.setLabelIfUnset(job.sessionId, label);
    yield* Effect.annotateLogs(Effect.logInfo("session named"), {
      sessionId: job.sessionId,
      label,
      wrote,
    });
  });
  const leaveUnnamed = (why: string) =>
    Effect.logInfo(`session left unnamed · ${why}`).pipe(
      Effect.annotateLogs({ sessionId: job.sessionId, status: session.status }),
    );

  if (seen.length > 0) {
    const label = yield* named({ messages: seen });
    if (label !== null) return yield* write(label);
    // What Mend saw names nothing yet. The next message it is sent queues the namer again; a
    // terminal the person types into is read below, retried until it says more.
    if (!readsTranscript) return yield* leaveUnnamed("its first messages name no subject yet");
  }

  const turns = yield* openingMessagesFromTranscript(job, session);
  if (turns === null) return yield* leaveUnnamed("it settled without a first prompt");
  const label = yield* named(turns);
  if (label !== null) return yield* write(label);
  if (withoutFirstPrompt(session) === "leave-unnamed")
    return yield* leaveUnnamed("it settled before its messages named a subject");
  return yield* awaitTranscript("the first prompts name no subject yet");
});

/**
 * A message reached an unnamed session: queue its namer now, as a composed start does, so it is
 * named from the message (`nameSession` reads it from Mend's record) instead of waiting on the
 * launch's job, which starts late and stops retrying after a few minutes. Its own key, so the
 * launch's job, still waiting, doesn't absorb it; whichever runs second finds the label set and
 * does nothing. Best-effort: a send never fails because naming could not queue.
 */
export const nameOnMessage = (session: {
  readonly id: SessionId;
  readonly label: string | null;
}): Effect.Effect<void, never, JobRunner> =>
  session.label !== null
    ? Effect.void
    : Effect.gen(function* () {
        yield* (yield* JobRunner).enqueue({
          name: "name-session",
          payload: { sessionId: session.id },
          idempotencyKey: `name-session:${session.id}:message`,
          retryDelaySeconds: 30,
          retryLimit: 3,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-name enqueue on a message failed; continuing").pipe(
            Effect.annotateLogs({ sessionId: session.id, cause: Cause.pretty(cause) }),
          ),
        ),
      );
